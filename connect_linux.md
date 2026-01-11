# Linux Bluetooth Thermal Printer Integration (RFCOMM)

**Project:** Custom ERP/POS System
**OS Environment:** Linux (Xubuntu/Qtile)
**Hardware:** Axioo Hype 1 (Intel Pentium N4010)
**Printer:** Thermal Printer 58mm (RPP02N)

---

## 1. Background & Challenge
Aplikasi POS berbasis Web (Node.js/Express) biasanya berkomunikasi dengan printer thermal menggunakan protokol **Serial (COM Port)**. Namun, di Linux, printer Bluetooth secara default terdeteksi sebagai device audio/input biasa via BlueZ, dan tidak otomatis muncul sebagai *serial file descriptor* di `/dev/`.

**Solusi:** Kita harus melakukan *binding* manual menggunakan protokol **RFCOMM** untuk membuat "Virtual Serial Port" (misalnya: `/dev/rfcomm0`), sehingga aplikasi POS bisa "melihat" printer bluetooth seolah-olah dicolok via kabel serial.

---

## 2. Implementation Steps

### Step 1: Scanning Device
Pastikan Bluetooth menyala dan printer dalam mode pairing.

```bash
hcitool scan
# Output contoh:
# 86:67:7A:48:57:D5   RPP02N
```
*Catat MAC Address printer.*

### Step 2: Manual Binding (Testing)
Untuk pengetesan sementara (akan hilang saat restart), gunakan perintah berikut:

```bash
# Bind MAC Address ke port rfcomm0
sudo rfcomm bind /dev/rfcomm0 86:67:7A:48:57:D5

# Berikan akses Read/Write (agar Node.js tidak Permission Denied)
sudo chmod 666 /dev/rfcomm0
```
*Verifikasi:* Cek apakah file sudah terbentuk dengan `ls -l /dev/rfcomm0`.

### Step 3: Automation (Systemd Service)
Agar koneksi otomatis terjalin saat laptop dinyalakan (persisten), kita buat service systemd.

**1. Buat file service:**
```bash
sudo nano /etc/systemd/system/printer-connect.service
```

**2. Masukkan konfigurasi:**
```ini
[Unit]
Description=Auto Bind Bluetooth Printer (RPP02N)
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=oneshot
RemainAfterExit=yes

# Bersihkan koneksi lama (prevents 'Address already in use' error)
ExecStartPre=-/usr/bin/rfcomm release /dev/rfcomm0

# Bind Printer (GANTI MAC ADDRESS DI SINI)
ExecStart=/usr/bin/rfcomm bind /dev/rfcomm0 86:67:7A:48:57:D5

# Grant Permission
ExecStartPost=/usr/bin/chmod 666 /dev/rfcomm0

# Clean up saat stop
ExecStop=/usr/bin/rfcomm release /dev/rfcomm0

[Install]
WantedBy=multi-user.target
```

**3. Enable & Start Service:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable printer-connect.service
sudo systemctl start printer-connect.service
```

---

## 3. Application Integration (Node.js/Express)
Di sisi aplikasi (misal menggunakan library `escpos` atau serial adapter), port yang dipilih adalah:

* **Port Path:** `/dev/rfcomm0`
* **BaudRate:** 9600 (Standard thermal printer murah)

Jika list port tidak muncul di dropdown aplikasi, restart service Node.js agar melakukan scan ulang terhadap direktori `/dev/`.

---

## 4. Lessons Learned

### A. Low Cost, High Impact Architecture
Project ini membuktikan bahwa **spesifikasi hardware rendah bukan penghalang**.
* **Laptop:** Axioo Hype 1 (Pentium N4010) yang mungkin lambat di Windows, berjalan sangat responsif dengan Linux + Qtile Window Manager.
* **Printer:** Printer generic 200rb-an (RPP02N) bisa berfungsi setara printer bermerek jutaan rupiah dengan konfigurasi driver yang tepat.

### B. Linux as a Kiosk/POS Platform
Linux memberikan kontrol penuh terhadap hardware. Kemampuan untuk memanipulasi device node (`/dev/`) dan membuat *custom startup service* menjadikan Linux OS yang jauh lebih stable dan predictable untuk mesin kasir dibandingkan Windows yang sering terganggu update otomatis.

### C. The Power of "Everything is a File"
Di Unix/Linux, printer hanyalah sebuah file. Kita bisa mengirim teks ke printer hanya dengan command:
`echo "Test Print" > /dev/rfcomm0`
Pemahaman ini mempermudah debugging tanpa perlu menyentuh kode aplikasi utama.
