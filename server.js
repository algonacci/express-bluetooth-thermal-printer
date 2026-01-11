const express = require("express");
const cors = require("cors");
const { SerialPort } = require("serialport");
const escpos = require("escpos");
const path = require("path");
const EventEmitter = require("events");
// Jimp for Image Resizing
const { Jimp } = require("jimp");

// Load adapters
try {
  escpos.USB = require("escpos-usb");
} catch (e) {
  console.warn("escpos-usb not found or failed to load");
}

// --------------------------------------------------------------------------
// Custom Standard Serial Adapter
// --------------------------------------------------------------------------
class SerialAdapter extends EventEmitter {
  constructor(printerPath, options) {
    super();
    this.options = options || { baudRate: 115200, autoOpen: false };
    this.path = printerPath;
    this.device = null;
  }

  open(callback) {
    const baudRate = parseInt(this.options.baudRate) || 115200;
    console.log(`Opening Serial Port: ${this.path} with rate ${baudRate}`);

    try {
      this.device = new SerialPort({
        path: this.path,
        baudRate: baudRate,
        autoOpen: false,
        rtscts: true, // Hardware flow control
      });

      this.device.on("error", (err) => {
        console.error("Serial Device Error:", err);
      });

      this.device.on("close", () => {
        this.emit("disconnect", this.device);
        this.device = null;
      });

      this.device.open(callback);
    } catch (err) {
      callback && callback(err);
    }
    return this;
  }

  write(data, callback) {
    if (this.device) {
      this.device.write(data, callback);
    } else {
      callback && callback(new Error("Device not open"));
    }
    return this;
  }

  close(callback, timeout) {
    if (!this.device || !this.device.isOpen) {
      this.device = null;
      return callback && callback();
    }
    this.device.drain(() => {
      if (this.device) {
        this.device.close((e) => {
          this.device = null;
          callback && callback(e);
        });
      } else {
        callback && callback();
      }
    });
    return this;
  }
}

// Assign adapter
escpos.Serial = SerialAdapter;

// --------------------------------------------------------------------------
// HELPER: Manual QR Code (Fastest)
// --------------------------------------------------------------------------
async function printQRManual(printer, url) {
  // GS ( k ...
  const header = Buffer.from([
    0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00, 0x1d, 0x28, 0x6b,
    0x03, 0x00, 0x31, 0x43, 0x06, 0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45,
    0x30,
  ]);
  printer.buffer.write(header);

  // Data
  const data = Buffer.from(url);
  const len = data.length + 3;
  const pL = len % 256;
  const pH = Math.floor(len / 256);

  printer.buffer.write(
    Buffer.from([0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30])
  );
  printer.buffer.write(data);

  // Print
  printer.buffer.write(
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30])
  );

  // Force Flush & Drain
  await new Promise((resolve) => {
    const buf = printer.buffer.flush();
    if (printer.adapter.device) {
      printer.adapter.device.write(buf, () => {
        printer.adapter.device.drain(resolve);
      });
    } else {
      resolve();
    }
  });
}

// --------------------------------------------------------------------------
// HELPER: Raster Image with DRAIN (No manual sleep, just physics)
// --------------------------------------------------------------------------
async function printRasterDrain(printer, image) {
  const raster = image.toRaster();
  const header = Buffer.from([0x1d, 0x76, 0x30, 0x00]);
  const width = raster.width;
  const height = raster.height;

  const xL = width % 256;
  const xH = Math.floor(width / 256);
  const yL = height % 256;
  const yH = Math.floor(height / 256);

  printer.buffer.write(header);
  printer.buffer.write(Buffer.from([xL, xH, yL, yH]));

  // Combine all image data
  printer.buffer.write(raster.data);

  // FLUSH and DRAIN
  // This ensures Node.js waits until all bytes are sent to the COM port buffer
  // AND the COM port buffer is empty (sent to printer) before proceeding.
  await new Promise((resolve) => {
    const buf = printer.buffer.flush();
    if (printer.adapter.device) {
      printer.adapter.device.write(buf, () => {
        printer.adapter.device.drain(resolve);
      });
    } else {
      resolve();
    }
  });
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Helpers
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scanPrinters() {
  try {
    const ports = await SerialPort.list();
    printersCache = ports.map((p) => ({
      id: p.path,
      name: p.friendlyName || p.pnpId || p.path,
      manufacturer: p.manufacturer,
    }));
    return printersCache;
  } catch (err) {
    console.error("Failed to scan printers:", err);
    return [];
  }
}

let printersCache = [];
let printQueue = [];
let printing = false;

app.get("/printers", async (req, res) => {
  const printers = await scanPrinters();
  res.json({ printers });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

async function processQueue() {
  if (printing || printQueue.length === 0) return;
  printing = true;

  const job = printQueue.shift();
  const { printerId, baudRate, simpleMode, res } = job;

  try {
    let device;
    let adapterType = "USB";

    if (
      printerId &&
      (printerId.toUpperCase().includes("COM") ||
        printerId.includes("tty") ||
        printerId.includes("rfcomm"))
    ) {
      adapterType = "Serial";
      const rate = parseInt(baudRate) || 115200;
      device = new escpos.Serial(printerId, { baudRate: rate });
    } else {
      adapterType = "USB";
      if (!escpos.USB) throw new Error("USB adapter not found (escpos-usb).");
      device = new escpos.USB();
    }

    const printer = new escpos.Printer(device);

    device.open(async (error) => {
      if (error) {
        printing = false;
        console.error("Device open error:", error);
        res.json({
          success: false,
          error: "Could not open printer. " + error.message,
        });
        setTimeout(processQueue, 500);
        return;
      }

      try {
        console.log(
          `Printer connected (${adapterType}), starting print job...`
        );

        // SIMPLE MODE
        if (simpleMode) {
          printer.align("CT");
          printer.text("--- TEST PRINT ---");
          printer.feed(1);
          printer.text("Connection OK!");
          printer.feed(2);
          printer.cut();
          printer.close();
          res.json({ success: true, message: "Test print sent!" });
          return;
        }

        // REGULAR MODE

        // 1. Logo (Resized + Optimized Drain)
        try {
          const logoPath = path.join(__dirname, "logo.png");

          // Resize Image using Jimp (v1.x uses object arguments)
          const jimpImage = await Jimp.read(logoPath);
          jimpImage.resize({ w: 300 }); // Zod expects object

          // Get Buffer (PNG)
          const resizedBuffer = await jimpImage.getBuffer("image/png");

          // Load into escpos.Image
          const logo = await new Promise((resolve, reject) => {
            escpos.Image.load(resizedBuffer, "image/png", (result) => {
              if (result instanceof Error) reject(result);
              else resolve(result);
            });
          });

          printer.align("CT");
          await printRasterDrain(printer, logo);
        } catch (imgErr) {
          console.warn("Skipping logo:", imgErr);
          printer.text("=== BRAINCORE POS ===");
        }
        printer.feed(2); // Added more space below logo

        // 2. Items
        printer.align("LT");
        const items = [
          { name: "Nasi Goreng", price: 20000 },
          { name: "Es Teh", price: 5000 },
          { name: "Mie Ayam", price: 15000 },
        ];
        items.forEach((i) => {
          printer.text(`${i.name} - ${i.price}`);
        });
        printer.feed(1);

        // 3. Barcode (EAN13 - Proven Working)
        printer.align("CT");
        printer.barcode("123456789012", "EAN13", { width: 2, height: 50 });
        printer.feed(1);

        // 4. QR Code (Manual Native Command - Proven Working)
        printer.align("CT");
        try {
          await printQRManual(printer, "https://braincore.id");
        } catch (e) {
          printer.text("QR Failed");
        }
        printer.feed(1); // Reduced gap before footer

        // 5. Footer & Cut
        printer.text("--- THANK YOU ---");
        printer.cut();

        // Close
        printer.close();

        res.json({ success: true, message: "Print sent successfully!" });
      } catch (err) {
        console.error("Printing error sequence:", err);
        try {
          printer.close();
        } catch (e) {}
        res.json({ success: false, error: err.message });
      } finally {
        printing = false;
        setTimeout(processQueue, 1000);
      }
    });
  } catch (err) {
    printing = false;
    console.error("Exception in print job setup:", err);
    res.json({ success: false, error: err.message });
    setTimeout(processQueue, 1000);
  }
}

app.post("/print", (req, res) => {
  const { printerId, baudRate, simpleMode } = req.body;
  printQueue.push({ printerId, baudRate, simpleMode, res });
  processQueue();
});

const PORT = 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Print agent running on http://0.0.0.0:${PORT}`);
});
