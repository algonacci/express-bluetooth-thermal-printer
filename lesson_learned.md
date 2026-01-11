# Lesson Learned: Node.js Thermal Printing (Serial/Bluetooth)

## 1. Serial Communication & Buffer Overflow
**The Problem:**
Thermal printers connected via Serial (COM/Bluetooth) at standard baud rates (e.g., 115200) have limited buffer sizes (often ~4KB). Sending large data payloads, such as uncompressed bitmap images, often causes the printer's buffer to overflow. This results in:
*   Stops printing mid-way.
*   Prints garbage characters.
*   Ejects blank paper ("White Print") because the command structure gets corrupted.

**The Solution:**
*   **Hardware Flow Control:** Always enable `rtscts: true` in the SerialPort configuration. This allows the printer to physically signal the PC to stop sending data when its buffer is full.
*   **Drain:** Use `serialPort.drain()` after sending heavy data (like images). This forces Node.js to wait until the OS has actually transmitted all bytes from the output buffer before proceeding to the next command.
*   **Avoid Manual Chunking:** While manually splitting data into chunks with `setTimeout` works, it is extremely slow. Hardware flow control + Drain is the robust, high-performance solution.

## 2. Printing Logos (Raster Images)
**Key Insight:** Sending a raw full-resolution image (e.g., 2000px wide) will almost always fail on Serial connection.
*   **Resize is Mandatory:** You must resize the image to a width suitable for the printer paper (e.g., **300px** - 380px for 58mm paper).
*   **Library:** Used `jimp` to resize the image buffer on the fly before passing it to `escpos.Image`.
*   **API Note:** `jimp` v1.6+ requires object arguments for resize: `image.resize({ w: 300 })`.

## 3. Printing QR Codes
**The Problem:**
The default `printer.qrimage()` checks pixels and prints the QR code as a **Raster Image**. This is:
1.  Slow (heavy data payload).
2.  Blurry (dependent on dithering).
3.  Prone to buffer overflow errors.

**The Solution: Native Commands**
Use the printer's internal firmware to generate the QR code. This sends only a few bytes (the URL string + metadata), which is instant and crisp.
*   **Command:** `GS ( k` (Function 180 or 181).
*   **Implementation:** We created a `printQRManual` helper to inject the raw hex bytes, bypassing the library's bitmap generator.

## 4. Library Compatibility
*   **SerialPort:** The `escpos` library is old. Its `escpos-serialport` adapter does not work with modern `serialport` v10+.
    *   *Fix:* We wrote a custom `SerialAdapter` class that wraps the new `serialport` API and assigns it to `escpos.Serial`.
*   **Zod/Jimp:** Modern libraries function differently. Always check recent documentation (e.g., Jimp using Zod schema validation for inputs).

## 5. Network Access (Mobile to Localhost)
To access the printer server from a mobile device on the same WiFi:
*   **Firewall:** Windows Firewall often blocks incoming connections to Node.js ports. You must Allow the port (3000) or temporarily disable the firewall.
*   **Dynamic IP:** The frontend `index.html` should use `window.location.origin` instead of hardcoded IPs (like `192.168.0.100`) so it works automatically regardless of the host's assigned IP.

## Summary Checklist for Robust Serial Printing
- [x] Use `serialport` v10+ with Custom Adapter.
- [x] Enable `rtscts: true`.
- [x] Resize all images to < 400px width.
- [x] Use `device.drain()` after image writes.
- [x] Use Native ESC/POS commands for QR Codes and Barcodes.
