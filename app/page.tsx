'use client';

import React, { useState, useEffect, useRef } from 'react';
import { openDB } from 'idb';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface KaryawanItem {
  id_karyawan: string;
  nama: string;
  pin: string;
  role: 'admin' | 'karyawan';
}

interface JadwalItem {
  id_karyawan: string;
  nama: string;
  tanggal: string;
  jam_berangkat: string;
  jam_pulang: string;
  toleransi_menit: number;
}

interface AbsenRecord {
  id_log: string;
  tanggal: string;
  id_karyawan: string;
  nama: string;
  jenis: 'MASUK' | 'KELUAR';
  waktu_scan: string;
  jadwal_berangkat: string;
  telat_menit: number;
  status: string;
  koordinat_gps: string;
  jarak_meter: number;
  mode_rekam: 'Online' | 'Offline-Sync';
  qr_id: string;
}

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorInstance {
  detect: (source: HTMLVideoElement) => Promise<DetectedBarcode[]>;
}

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance;

const KANTOR_LAT = -6.9148609;
const KANTOR_LNG = 109.7446830;
const MAX_RADIUS = 150;
const OFFICIAL_QR_CODE = 'ABSENSI-KANTOR-MPI-BTG';

async function getLocalDB() {
  return openDB('AbsensiNeonDB', 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id_log' });
      }
      if (!db.objectStoreNames.contains('logs')) {
        db.createObjectStore('logs', { keyPath: 'id_log' });
      }
      if (!db.objectStoreNames.contains('jadwal')) {
        db.createObjectStore('jadwal', { keyPath: ['id_karyawan', 'tanggal'] });
      }
      if (!db.objectStoreNames.contains('users')) {
        db.createObjectStore('users', { keyPath: 'id_karyawan' });
      }
    },
  });
}

function hitungJarakMeter(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function nowHHMM(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export default function AbsensiPage() {
  const [user, setUser] = useState<KaryawanItem | null>(null);
  const [loginId, setLoginId] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [loadingLogin, setLoadingLogin] = useState(false);

  const [isOnline, setIsOnline] = useState(true);
  const [queueCount, setQueueCount] = useState(0);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [jarakMeter, setJarakMeter] = useState<number | null>(null);
  const [jenisAbsen, setJenisAbsen] = useState<'MASUK' | 'KELUAR'>('MASUK');

  const [scanning, setScanning] = useState(false);
  const [manualQr, setManualQr] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);

  const [karyawanList, setKaryawanList] = useState<KaryawanItem[]>([]);
  const [jadwalList, setJadwalList] = useState<JadwalItem[]>([]);
  const [logs, setLogs] = useState<AbsenRecord[]>([]);
  const [filterLaporan, setFilterLaporan] = useState<'Harian' | 'Mingguan' | 'Bulanan'>('Harian');

  const [formId, setFormId] = useState('');
  const [formNama, setFormNama] = useState('');
  const [formPin, setFormPin] = useState('1234');
  const [formRole, setFormRole] = useState<'karyawan' | 'admin'>('karyawan');

  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=12&data=${encodeURIComponent(
    OFFICIAL_QR_CODE
  )}`;

  useEffect(() => {
    setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
    const onOnline = () => {
      setIsOnline(true);
      syncOfflineQueue();
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    const savedUser = localStorage.getItem('absensi_user');
    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser));
      } catch {
        localStorage.removeItem('absensi_user');
      }
    }

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
    };
  }, []);

  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setGpsCoords({ lat, lng });
        setJarakMeter(hitungJarakMeter(lat, lng, KANTOR_LAT, KANTOR_LNG));
      },
      () => {
        setJarakMeter(null);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  useEffect(() => {
    if (user) {
      refreshAllData();
      syncOfflineQueue();
    }
  }, [user]);

  async function refreshAllData() {
    const db = await getLocalDB();
    const qAll = await db.getAll('queue');
    setQueueCount(qAll.length);

    if (navigator.onLine) {
      try {
        const [resK, resJ, resA] = await Promise.all([
          fetch('/api/karyawan').then((r) => r.json()),
          fetch('/api/jadwal').then((r) => r.json()),
          fetch('/api/absen').then((r) => r.json()),
        ]);
        if (resK.status === 'ok') {
          setKaryawanList(resK.data);
          const tx = db.transaction('users', 'readwrite');
          await tx.store.clear();
          for (const u of resK.data) await tx.store.put(u);
          await tx.done;
        }
        if (resJ.status === 'ok') {
          setJadwalList(resJ.data);
          const tx = db.transaction('jadwal', 'readwrite');
          for (const j of resJ.data) await tx.store.put(j);
          await tx.done;
        }
        if (resA.status === 'ok') {
          setLogs(resA.data);
          const tx = db.transaction('logs', 'readwrite');
          for (const l of resA.data) await tx.store.put(l);
          await tx.done;
        }
        return;
      } catch {
        // Fallback ke IndexedDB saat jaringan tidak stabil
      }
    }

    setKaryawanList(await db.getAll('users'));
    setJadwalList(await db.getAll('jadwal'));
    const cachedLogs = await db.getAll('logs');
    setLogs(cachedLogs.reverse());
  }

  async function syncOfflineQueue() {
    if (!navigator.onLine) return;
    const db = await getLocalDB();
    const queued: AbsenRecord[] = await db.getAll('queue');
    if (queued.length === 0) {
      setQueueCount(0);
      return;
    }
    try {
      const res = await fetch('/api/absen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: queued }),
      }).then((r) => r.json());

      if (res.status === 'ok') {
        const tx = db.transaction('queue', 'readwrite');
        await tx.store.clear();
        await tx.done;
        setQueueCount(0);
        await refreshAllData();
      }
    } catch {
      // Tetap simpan di antrean sampai sinyal kembali normal
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    const id = loginId.trim().toUpperCase();
    const pin = loginPin.trim();
    if (!id || !pin) return alert('Masukkan ID dan PIN!');
    setLoadingLogin(true);
    try {
      if (navigator.onLine) {
        const res = await fetch('/api/karyawan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'login', id_karyawan: id, pin }),
        }).then((r) => r.json());

        if (res.status === 'ok') {
          setUser(res.user);
          localStorage.setItem('absensi_user', JSON.stringify(res.user));
          setLoadingLogin(false);
          return;
        }
        alert(res.message || 'ID atau PIN salah!');
      } else {
        const db = await getLocalDB();
        const localUser = await db.get('users', id);
        if (localUser && localUser.pin === pin) {
          setUser(localUser);
          localStorage.setItem('absensi_user', JSON.stringify(localUser));
        } else {
          alert('Login offline gagal: data user belum tersimpan atau PIN salah.');
        }
      }
    } catch {
      alert('Gagal terhubung ke server.');
    } finally {
      setLoadingLogin(false);
    }
  }

  function handleLogout() {
    stopCamera();
    localStorage.removeItem('absensi_user');
    setUser(null);
  }

  async function handleInstallPWA() {
    if (!installPrompt) {
      alert('Ketuk ikon titik tiga (⋮) di pojok kanan atas Chrome lalu pilih "Install aplikasi".');
      return;
    }
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  function stopCamera() {
    if (scanTimerRef.current) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setScanning(false);
  }

  async function startCamera() {
    if (jarakMeter === null) {
      alert('Lokasi GPS belum terkunci. Pastikan GPS HP aktif lalu tunggu beberapa detik.');
      return;
    }
    if (jarakMeter > MAX_RADIUS) {
      alert(`Anda berada di luar radius kantor (${jarakMeter}m > ${MAX_RADIUS}m). Absensi ditolak.`);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      setScanning(true);

      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }, 150);

      const BarcodeDetectorClass = (
        window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }
      ).BarcodeDetector;

      if (BarcodeDetectorClass) {
        const detector = new BarcodeDetectorClass({ formats: ['qr_code'] });
        scanTimerRef.current = window.setInterval(async () => {
          if (!videoRef.current || videoRef.current.readyState < 2) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0 && codes[0].rawValue) {
              const scannedValue = codes[0].rawValue.trim();
              stopCamera();
              await prosesAbsenQR(scannedValue);
            }
          } catch {
            // Abaikan frame yang belum terbaca
          }
        }, 450);
      }
    } catch {
      alert('Tidak dapat membuka kamera. Pastikan izin kamera di browser sudah diaktifkan.');
    }
  }

  async function prosesAbsenQR(qrText: string) {
    if (!user) return;
    const cleanQr = qrText.trim();

    if (cleanQr !== OFFICIAL_QR_CODE) {
      alert(
        `QR Code tidak valid ("${cleanQr}").\nHarap pindai QR Code resmi Kantor Utama (${OFFICIAL_QR_CODE}).`
      );
      return;
    }

    if (jarakMeter === null || jarakMeter > MAX_RADIUS) {
      alert(`Gagal: Posisi GPS di luar radius kantor (${jarakMeter ?? '-'}m / maks ${MAX_RADIUS}m).`);
      return;
    }

    const tgl = todayISO();
    const waktuScan = nowHHMM();
    const jadwalHariIni = jadwalList.find(
      (j) => j.id_karyawan === user.id_karyawan && j.tanggal === tgl
    );
    const jamJadwal = jadwalHariIni?.jam_berangkat || '07:00';
    const toleransi = jadwalHariIni?.toleransi_menit ?? 10;

    let telatMenit = 0;
    let status = 'Tepat Waktu';

    if (jenisAbsen === 'MASUK') {
      const [jh, jm] = jamJadwal.split(':').map(Number);
      const [sh, sm] = waktuScan.split(':').map(Number);
      const diff = sh * 60 + sm - (jh * 60 + jm);
      if (diff > toleransi) {
        telatMenit = diff;
        status = `Terlambat ${diff}m`;
      }
    } else {
      status = 'Pulang';
    }

    const record: AbsenRecord = {
      id_log: `${tgl}_${user.id_karyawan}_${jenisAbsen}_${Date.now()}`,
      tanggal: tgl,
      id_karyawan: user.id_karyawan,
      nama: user.nama,
      jenis: jenisAbsen,
      waktu_scan: waktuScan,
      jadwal_berangkat: jamJadwal,
      telat_menit: telatMenit,
      status,
      koordinat_gps: gpsCoords ? `${gpsCoords.lat.toFixed(6)},${gpsCoords.lng.toFixed(6)}` : '-',
      jarak_meter: jarakMeter,
      mode_rekam: navigator.onLine ? 'Online' : 'Offline-Sync',
      qr_id: cleanQr,
    };

    const db = await getLocalDB();
    await db.put('logs', record);
    setLogs((prev) => [record, ...prev]);

    if (navigator.onLine) {
      try {
        const res = await fetch('/api/absen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: [record] }),
        }).then((r) => r.json());

        if (res.status === 'ok') {
          alert(`Absen ${jenisAbsen} berhasil dicatat (${waktuScan}) • ${status}`);
          return;
        }
      } catch {
        // Lanjut simpan ke antrean offline
      }
    }

    await db.put('queue', record);
    const qAll = await db.getAll('queue');
    setQueueCount(qAll.length);
    alert(`Mode Offline: Absen ${jenisAbsen} disimpan ke antrean (${waktuScan}) dan akan otomatis terkirim saat online.`);
  }

  async function handleDownloadQR() {
    try {
      const response = await fetch(qrImageUrl);
      const blob = await response.blob();
      const imgBitmap = await createImageBitmap(blob);

      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 8;
      ctx.strokeRect(20, 20, 560, 680);

      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('QR ABSENSI KANTOR UTAMA', 300, 80);

      ctx.font = '18px sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText('Pindai untuk Absen MASUK & KELUAR', 300, 115);

      ctx.drawImage(imgBitmap, 100, 145, 400, 400);

      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 26px monospace';
      ctx.fillText(OFFICIAL_QR_CODE, 300, 600);

      ctx.font = '16px sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText(`Radius GPS Aktif: Maks ${MAX_RADIUS} Meter`, 300, 645);

      const link = document.createElement('a');
      link.download = `QR-Absensi-${OFFICIAL_QR_CODE}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch {
      window.open(qrImageUrl, '_blank');
    }
  }

  function handlePrintQR() {
    const printWin = window.open('', '_blank', 'width=600,height=750');
    if (!printWin) return;
    printWin.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Cetak QR Absensi - ${OFFICIAL_QR_CODE}</title>
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
            .card { border: 4px solid #0f172a; border-radius: 16px; padding: 32px; text-align: center; width: 360px; }
            h1 { font-size: 22px; margin: 0 0 8px; color: #0f172a; }
            p { font-size: 14px; color: #475569; margin: 0 0 20px; }
            img { width: 280px; height: 280px; display: block; margin: 0 auto 16px; }
            .code { font-family: monospace; font-size: 20px; font-weight: bold; letter-spacing: 1px; color: #0f172a; }
            .note { font-size: 12px; color: #64748b; margin-top: 12px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>QR ABSENSI KANTOR UTAMA</h1>
            <p>Buka Aplikasi Absensi &rarr; Pilih MASUK / KELUAR &rarr; Pindai QR</p>
            <img src="${qrImageUrl}" onload="window.print();" />
            <div class="code">${OFFICIAL_QR_CODE}</div>
            <div class="note">Validasi GPS Aktif • Radius Maks ${MAX_RADIUS} Meter</div>
          </div>
        </body>
      </html>
    `);
    printWin.document.close();
  }

  async function handleUploadJadwal(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
      const formatted: JadwalItem[] = rawRows.map((r) => ({
        id_karyawan: String(r.id_karyawan || r.ID || '').trim().toUpperCase(),
        nama: String(r.nama || r.Nama || '').trim(),
        tanggal: String(r.tanggal || r.Tanggal || todayISO()).trim(),
        jam_berangkat: String(r.jam_berangkat || r.Jam_Masuk || '07:00').trim(),
        jam_pulang: String(r.jam_pulang || r.Jam_Pulang || '17:00').trim(),
        toleransi_menit: Number(r.toleransi_menit || 10),
      })).filter((item) => item.id_karyawan && item.tanggal);

      if (formatted.length === 0) {
        alert('Format file tidak sesuai. Pastikan ada kolom: id_karyawan, nama, tanggal, jam_berangkat.');
        return;
      }

      const res = await fetch('/api/jadwal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: formatted }),
      }).then((r) => r.json());

      if (res.status === 'ok') {
        alert(`Berhasil menyimpan ${res.saved} jadwal keberangkatan.`);
        await refreshAllData();
      }
    } catch {
      alert('Gagal membaca file jadwal.');
    }
  }

  async function handleSaveKaryawan(e: React.FormEvent) {
    e.preventDefault();
    const id = formId.trim().toUpperCase();
    const nama = formNama.trim();
    const pin = formPin.trim() || '1234';
    if (!id || !nama) return alert('ID dan Nama wajib diisi!');

    const res = await fetch('/api/karyawan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_karyawan: id, nama, pin, role: formRole }),
    }).then((r) => r.json());

    if (res.status === 'ok') {
      setFormId('');
      setFormNama('');
      setFormPin('1234');
      setFormRole('karyawan');
      await refreshAllData();
    } else {
      alert(res.message || 'Gagal menyimpan data karyawan.');
    }
  }

  async function handleDeleteKaryawan(id: string) {
    if (id === 'ADM-001') return alert('Akun Admin utama tidak boleh dihapus.');
    if (!confirm(`Hapus karyawan ${id}?`)) return;
    const res = await fetch(`/api/karyawan?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).then((r) => r.json());
    if (res.status === 'ok') {
      await refreshAllData();
    }
  }

  const filteredLogs = logs.filter((l) => {
    if (user?.role !== 'admin' && l.id_karyawan !== user?.id_karyawan) return false;
    const tgl = l.tanggal;
    const today = todayISO();
    if (filterLaporan === 'Harian') return tgl === today;
    if (filterLaporan === 'Mingguan') {
      const diff = (new Date(today).getTime() - new Date(tgl).getTime()) / (1000 * 3600 * 24);
      return diff >= 0 && diff <= 7;
    }
    return tgl.slice(0, 7) === today.slice(0, 7);
  });

  function exportXLSX() {
    const ws = XLSX.utils.json_to_sheet(filteredLogs);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Laporan_Absensi');
    XLSX.writeFile(wb, `Laporan_Absensi_${filterLaporan}_${todayISO()}.xlsx`);
  }

  function exportCSV() {
    const ws = XLSX.utils.json_to_sheet(filteredLogs);
    const csv = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Laporan_Absensi_${filterLaporan}_${todayISO()}.csv`;
    a.click();
  }

  function exportPDF() {
    const doc = new jsPDF();
    doc.text(`Laporan Absensi (${filterLaporan}) - ${todayISO()}`, 14, 16);
    autoTable(doc, {
      startY: 22,
      head: [['Tanggal', 'Nama', 'Jenis', 'Scan', 'Telat', 'Status', 'Mode']],
      body: filteredLogs.map((l) => [
        l.tanggal,
        l.nama,
        l.jenis,
        l.waktu_scan,
        `${l.telat_menit}m`,
        l.status,
        l.mode_rekam,
      ]),
    });
    doc.save(`Laporan_Absensi_${filterLaporan}_${todayISO()}.pdf`);
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-slate-100 p-4 max-w-md mx-auto">
        <div className="bg-slate-900 text-white rounded-2xl p-4 mb-5 shadow">
          <h1 className="font-bold text-lg tracking-wide">APLIKASI ABSENSI QR &amp; GPS</h1>
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button
              onClick={handleInstallPWA}
              className="bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold px-3 py-1.5 rounded-full"
            >
              + Install Aplikasi
            </button>
            <span
              className={`text-xs font-semibold px-3 py-1.5 rounded-full ${
                isOnline ? 'bg-emerald-600' : 'bg-amber-600'
              }`}
            >
              {isOnline ? 'ONLINE' : 'OFFLINE'} • ANTREAN: {queueCount}
            </span>
          </div>
        </div>

        <form onSubmit={handleLogin} className="bg-white rounded-2xl p-5 shadow space-y-4">
          <h2 className="font-bold text-slate-800 text-base">Login Karyawan / Admin</h2>
          <input
            type="text"
            placeholder="ID (KRY-001 / ADM-001)"
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            className="w-full border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm uppercase"
          />
          <input
            type="password"
            placeholder="PIN"
            value={loginPin}
            onChange={(e) => setLoginPin(e.target.value)}
            className="w-full border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm"
          />
          <button
            type="submit"
            disabled={loadingLogin}
            className="w-full bg-blue-700 hover:bg-blue-600 text-white font-semibold py-2.5 rounded-xl text-sm"
          >
            {loadingLogin ? 'Memeriksa...' : 'Masuk Aplikasi'}
          </button>
        </form>
      </main>
    );
  }

  const todaySchedule = jadwalList.find(
    (j) => j.id_karyawan === user.id_karyawan && j.tanggal === todayISO()
  );
  const gpsAman = jarakMeter !== null && jarakMeter <= MAX_RADIUS;

  return (
    <main className="min-h-screen bg-slate-100 p-4 max-w-md mx-auto space-y-4 pb-10">
      {/* Header */}
      <div className="bg-slate-900 text-white rounded-2xl p-4 shadow">
        <h1 className="font-bold text-base tracking-wide">APLIKASI ABSENSI QR &amp; GPS</h1>
        <p className="text-xs text-slate-300 mt-0.5">
          {user.nama} ({user.id_karyawan}) • {user.role.toUpperCase()}
        </p>
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span
            className={`text-xs font-semibold px-3 py-1 rounded-full ${
              isOnline ? 'bg-emerald-600' : 'bg-amber-600'
            }`}
          >
            {isOnline ? 'ONLINE' : 'OFFLINE'} • ANTREAN: {queueCount}
          </span>
          {installPrompt && (
            <button
              onClick={handleInstallPWA}
              className="bg-indigo-600 text-xs font-semibold px-3 py-1 rounded-full"
            >
              + Install
            </button>
          )}
          <button
            onClick={handleLogout}
            className="bg-red-600 hover:bg-red-500 text-xs font-semibold px-3 py-1 rounded-full"
          >
            Keluar
          </button>
        </div>
      </div>

      {/* 1. Scan QR & GPS Realtime */}
      <section className="bg-white rounded-2xl p-4 shadow space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">1. Scan QR &amp; GPS Realtime</h2>
        <p className="text-xs text-slate-600">
          Jadwal Masuk: <strong>{todaySchedule?.jam_berangkat || '07:00'}</strong>
        </p>
        <p className={`text-xs font-semibold ${gpsAman ? 'text-emerald-600' : 'text-red-600'}`}>
          GPS:{' '}
          {jarakMeter === null
            ? 'Mencari sinyal lokasi GPS...'
            : `Jarak ${jarakMeter}m (${gpsAman ? 'Aman' : 'Di Luar Radius'})`}
        </p>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setJenisAbsen('MASUK')}
            className={`py-2 rounded-xl text-xs font-bold border ${
              jenisAbsen === 'MASUK'
                ? 'bg-blue-700 text-white border-blue-700'
                : 'bg-white text-slate-700 border-slate-300'
            }`}
          >
            MASUK
          </button>
          <button
            type="button"
            onClick={() => setJenisAbsen('KELUAR')}
            className={`py-2 rounded-xl text-xs font-bold border ${
              jenisAbsen === 'KELUAR'
                ? 'bg-blue-700 text-white border-blue-700'
                : 'bg-white text-slate-700 border-slate-300'
            }`}
          >
            KELUAR
          </button>
        </div>

        {!scanning ? (
          <button
            type="button"
            onClick={startCamera}
            className="w-full bg-emerald-700 hover:bg-emerald-600 text-white font-semibold py-2.5 rounded-xl text-xs"
          >
            Buka Kamera Scan QR
          </button>
        ) : (
          <div className="space-y-2">
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full rounded-xl bg-black aspect-square object-cover"
            />
            <button
              type="button"
              onClick={stopCamera}
              className="w-full bg-red-600 text-white font-semibold py-2 rounded-xl text-xs"
            >
              Tutup Kamera
            </button>
          </div>
        )}

        <div className="pt-1 border-t border-slate-100 flex gap-2">
          <input
            type="text"
            placeholder="Input Kode QR manual jika kamera terkendala"
            value={manualQr}
            onChange={(e) => setManualQr(e.target.value)}
            className="flex-1 border border-slate-300 rounded-xl px-3 py-2 text-xs"
          />
          <button
            type="button"
            onClick={() => {
              if (!manualQr.trim()) return;
              prosesAbsenQR(manualQr);
              setManualQr('');
            }}
            className="bg-slate-800 text-white text-xs font-semibold px-3 py-2 rounded-xl"
          >
            Kirim
          </button>
        </div>
      </section>

      {/* 2. Input Jadwal */}
      {user.role === 'admin' && (
        <section className="bg-white rounded-2xl p-4 shadow space-y-2">
          <h2 className="font-bold text-slate-800 text-sm">2. Input Jadwal (.XLSX / .CSV)</h2>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleUploadJadwal}
            className="w-full text-xs border border-slate-300 rounded-xl p-2"
          />
        </section>
      )}

      {/* 3. Laporan */}
      <section className="bg-white rounded-2xl p-4 shadow space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-slate-800 text-sm">3. Laporan:</h2>
          <select
            value={filterLaporan}
            onChange={(e) => setFilterLaporan(e.target.value as 'Harian' | 'Mingguan' | 'Bulanan')}
            className="border border-slate-300 rounded-lg px-2.5 py-1 text-xs"
          >
            <option value="Harian">Harian</option>
            <option value="Mingguan">Mingguan</option>
            <option value="Bulanan">Bulanan</option>
          </select>
        </div>

        <div className="flex gap-2">
          <button
            onClick={exportXLSX}
            className="bg-emerald-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg"
          >
            XLSX
          </button>
          <button
            onClick={exportPDF}
            className="bg-red-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg"
          >
            PDF
          </button>
          <button
            onClick={exportCSV}
            className="bg-slate-800 text-white text-xs font-semibold px-3 py-1.5 rounded-lg"
          >
            CSV
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-[11px]">
            <thead>
              <tr className="bg-slate-900 text-white">
                <th className="p-2">Tanggal</th>
                <th className="p-2">Nama</th>
                <th className="p-2">Jenis</th>
                <th className="p-2">Scan</th>
                <th className="p-2">Telat</th>
                <th className="p-2">Status</th>
                <th className="p-2">Mode</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-3 text-center text-slate-400">
                    Belum ada data absensi.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((l) => (
                  <tr key={l.id_log} className="border-b border-slate-200">
                    <td className="p-2">{l.tanggal}</td>
                    <td className="p-2 font-medium">{l.nama}</td>
                    <td className="p-2">{l.jenis}</td>
                    <td className="p-2">{l.waktu_scan}</td>
                    <td className="p-2">{l.telat_menit}m</td>
                    <td className="p-2">{l.status}</td>
                    <td className="p-2">{l.mode_rekam}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 4. Panel Admin: QR Kantor Utama & Data Karyawan */}
      {user.role === 'admin' && (
        <>
          <section className="bg-white rounded-2xl p-4 shadow space-y-3 border-t-4 border-emerald-600">
            <h2 className="font-bold text-slate-800 text-sm">
              4. QR Code Resmi Kantor Utama
            </h2>
            <p className="text-xs text-slate-600">
              Cetak atau tampilkan QR Code ini di lokasi kantor. Sistem mengunci pemindaian agar
              karyawan hanya bisa absen <strong>MASUK</strong> dan <strong>KELUAR</strong> memakai
              QR resmi ini.
            </p>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col items-center">
              <img
                src={qrImageUrl}
                alt={`QR ${OFFICIAL_QR_CODE}`}
                className="w-48 h-48 rounded-lg border border-slate-300 bg-white p-2"
              />
              <span className="mt-2 font-mono font-bold text-sm text-slate-900">
                {OFFICIAL_QR_CODE}
              </span>
              <span className="text-[11px] text-slate-500">
                Radius GPS: Maks {MAX_RADIUS} meter
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleDownloadQR}
                className="bg-emerald-700 hover:bg-emerald-600 text-white font-semibold py-2 rounded-xl text-xs"
              >
                Download PNG
              </button>
              <button
                type="button"
                onClick={handlePrintQR}
                className="bg-slate-800 hover:bg-slate-700 text-white font-semibold py-2 rounded-xl text-xs"
              >
                Cetak QR
              </button>
            </div>
          </section>

          <section className="bg-white rounded-2xl p-4 shadow space-y-3 border-t-4 border-blue-700">
            <h2 className="font-bold text-slate-800 text-sm">5. Panel Admin: Data Karyawan</h2>
            <form onSubmit={handleSaveKaryawan} className="space-y-2.5">
              <input
                type="text"
                placeholder="ID (KRY-005)"
                value={formId}
                onChange={(e) => setFormId(e.target.value)}
                className="w-full border border-slate-300 rounded-xl px-3 py-2 text-xs uppercase"
              />
              <input
                type="text"
                placeholder="Nama Lengkap"
                value={formNama}
                onChange={(e) => setFormNama(e.target.value)}
                className="w-full border border-slate-300 rounded-xl px-3 py-2 text-xs"
              />
              <input
                type="text"
                placeholder="PIN (1234)"
                value={formPin}
                onChange={(e) => setFormPin(e.target.value)}
                className="w-full border border-slate-300 rounded-xl px-3 py-2 text-xs"
              />
              <select
                value={formRole}
                onChange={(e) => setFormRole(e.target.value as 'karyawan' | 'admin')}
                className="w-full border border-slate-300 rounded-xl px-3 py-2 text-xs"
              >
                <option value="karyawan">Karyawan</option>
                <option value="admin">Admin</option>
              </select>
              <button
                type="submit"
                className="w-full bg-blue-700 hover:bg-blue-600 text-white font-semibold py-2.5 rounded-xl text-xs"
              >
                Simpan
              </button>
            </form>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[11px]">
                <thead>
                  <tr className="bg-slate-900 text-white">
                    <th className="p-2">ID</th>
                    <th className="p-2">Nama</th>
                    <th className="p-2">PIN</th>
                    <th className="p-2">Role</th>
                    <th className="p-2">Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {karyawanList.map((k) => (
                    <tr key={k.id_karyawan} className="border-b border-slate-200">
                      <td className="p-2 font-semibold">{k.id_karyawan}</td>
                      <td className="p-2">{k.nama}</td>
                      <td className="p-2">{k.pin}</td>
                      <td className="p-2 uppercase">{k.role}</td>
                      <td className="p-2 flex gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setFormId(k.id_karyawan);
                            setFormNama(k.nama);
                            setFormPin(k.pin);
                            setFormRole(k.role);
                          }}
                          className="bg-amber-500 text-white px-2 py-1 rounded text-[10px] font-semibold"
                        >
                          Edit
                        </button>
                        {k.id_karyawan !== 'ADM-001' && (
                          <button
                            type="button"
                            onClick={() => handleDeleteKaryawan(k.id_karyawan)}
                            className="bg-red-600 text-white px-2 py-1 rounded text-[10px] font-semibold"
                          >
                            Hapus
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

    

        
