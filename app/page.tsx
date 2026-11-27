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

interface JadwalItem {
  id_karyawan: string;
  nama: string;
  tanggal: string;
  jam_berangkat: string;
  jam_pulang: string;
  toleransi_menit?: number;
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

const KANTOR_LAT = -6.914744;
const KANTOR_LNG = 109.712890;
const MAX_RADIUS = 150;

async function getLocalDB() {
  return openDB('AbsensiNeonDB', 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id_log' });
      if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { keyPath: 'id_log' });
      if (!db.objectStoreNames.contains('jadwal')) db.createObjectStore('jadwal', { keyPath: ['id_karyawan', 'tanggal'] });
      if (!db.objectStoreNames.contains('users')) db.createObjectStore('users', { keyPath: 'id_karyawan' });
    },
  });
}

function hitungJarakMeter(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export default function AbsensiPage() {
  const [user, setUser] = useState<{ id: string; nama: string } | null>(null);
  const [inpId, setInpId] = useState('');
  const [inpPin, setInpPin] = useState('');
  const [userRole, setUserRole] = useState<'admin' | 'karyawan'>('karyawan');
  const [isOnline, setIsOnline] = useState(true);
  const [queueCount, setQueueCount] = useState(0);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  const [gps, setGps] = useState<{ lat: number; lng: number; jarak: number } | null>(null);
  const [jenisAbsen, setJenisAbsen] = useState<'MASUK' | 'KELUAR'>('MASUK');
  const [jadwalHariIni, setJadwalHariIni] = useState('07:00');
  const [toleransiHariIni, setToleransiHariIni] = useState(10);
  const [logs, setLogs] = useState<AbsenRecord[]>([]);
  const [filterLaporan, setFilterLaporan] = useState<'harian' | 'mingguan' | 'bulanan'>('harian');
  const [scanning, setScanning] = useState(false);

  const [daftarKaryawan, setDaftarKaryawan] = useState<{ id_karyawan: string; nama: string; pin: string; role: string }[]>([]);
  const [formKry, setFormKry] = useState({ id_karyawan: '', nama: '', pin: '1234', role: 'karyawan' });
  const scannerRef = useRef<unknown>(null);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);

    setIsOnline(navigator.onLine);
    const onOnline = () => {
      setIsOnline(true);
      syncOfflineQueue();
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    const savedUser = localStorage.getItem('neon_absen_user');
    if (savedUser) {
      const parsed = JSON.parse(savedUser);
      setUser({ id: parsed.id, nama: parsed.nama });
      if (parsed.role === 'admin') {
        setUserRole('admin');
        loadKaryawan();
      }
    }
    refreshLocalAndCloud();

    const watchId = navigator.geolocation?.watchPosition(
      (pos) => {
        const jarak = hitungJarakMeter(pos.coords.latitude, pos.coords.longitude, KANTOR_LAT, KANTOR_LNG);
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, jarak });
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000 }
    );

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (watchId) navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    const today = new Date().toISOString().slice(0, 10);
    getLocalDB().then(async (db) => {
      const match = await db.get('jadwal', [user.id, today]);
      setJadwalHariIni(match ? match.jam_berangkat : '07:00');
      setToleransiHariIni(match?.toleransi_menit ?? 10);
    });
  }, [user]);

  async function installAplikasiKeHP() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setInstallPrompt(null);
  }

  async function refreshLocalAndCloud() {
    const db = await getLocalDB();
    setQueueCount((await db.getAll('queue')).length);

    if (navigator.onLine) {
      await syncOfflineQueue();
      try {
        const [resLogs, resJadwal, resUsers] = await Promise.all([
          fetch('/api/absen'),
          fetch('/api/jadwal'),
          fetch('/api/karyawan'),
        ]);
        const jsonLogs = await resLogs.json();
        const jsonJadwal = await resJadwal.json();
        const jsonUsers = await resUsers.json();

        if (jsonLogs.status === 'ok') {
          setLogs(jsonLogs.data);
          const tx = db.transaction('logs', 'readwrite');
          for (const item of jsonLogs.data) await tx.store.put(item);
          await tx.done;
        }
        if (jsonJadwal.status === 'ok') {
          const tx = db.transaction('jadwal', 'readwrite');
          for (const item of jsonJadwal.data) await tx.store.put(item);
          await tx.done;
        }
        if (jsonUsers.status === 'ok') {
          const tx = db.transaction('users', 'readwrite');
          for (const item of jsonUsers.data) await tx.store.put(item);
          await tx.done;
        }
      } catch {}
    } else {
      setLogs((await db.getAll('logs')).reverse());
    }
  }

  async function syncOfflineQueue() {
    if (!navigator.onLine) return;
    const db = await getLocalDB();
    const queue = await db.getAll('queue');
    if (queue.length === 0) return;
    try {
      const res = await fetch('/api/absen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: queue }),
      });
      if (res.ok) {
        const tx = db.transaction('queue', 'readwrite');
        await tx.store.clear();
        await tx.done;
        setQueueCount(0);
      }
    } catch {}
  }

  async function handleLoginDenganPin(e: React.FormEvent) {
    e.preventDefault();
    const cleanId = inpId.trim().toUpperCase();
    const cleanPin = inpPin.trim();
    if (!cleanId || !cleanPin) return alert('Masukkan ID Karyawan dan PIN!');

    const db = await getLocalDB();

    if (navigator.onLine) {
      const res = await fetch('/api/karyawan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', id_karyawan: cleanId, pin: cleanPin }),
      });
      const json = await res.json();
      if (!res.ok) return alert(json.message || 'Login gagal');

      await db.put('users', {
        id_karyawan: json.user.id_karyawan,
        nama: json.user.nama,
        pin: cleanPin,
        role: json.user.role,
      });

      const u = { id: json.user.id_karyawan, nama: json.user.nama, role: json.user.role };
      localStorage.setItem('neon_absen_user', JSON.stringify(u));
      setUser({ id: u.id, nama: u.nama });
      setUserRole(u.role);
      if (u.role === 'admin') loadKaryawan();
    } else {
      const cachedUser = await db.get('users', cleanId);
      if (cachedUser && cachedUser.pin === cleanPin) {
        const u = { id: cachedUser.id_karyawan, nama: cachedUser.nama, role: cachedUser.role };
        localStorage.setItem('neon_absen_user', JSON.stringify(u));
        setUser({ id: u.id, nama: u.nama });
        setUserRole(u.role);
        alert('Berhasil masuk menggunakan data Offline HP.');
      } else {
        alert('Data akun belum tersimpan offline. Sambungkan internet untuk login pertama kali.');
      }
    }
  }

  function handleLogout() {
    localStorage.removeItem('neon_absen_user');
    setUser(null);
    setUserRole('karyawan');
  }

  async function loadKaryawan() {
    const db = await getLocalDB();
    if (!navigator.onLine) {
      setDaftarKaryawan(await db.getAll('users'));
      return;
    }
    const res = await fetch('/api/karyawan');
    const json = await res.json();
    if (json.status === 'ok') {
      setDaftarKaryawan(json.data);
      const tx = db.transaction('users', 'readwrite');
      for (const u of json.data) await tx.store.put(u);
      await tx.done;
    }
  }

  async function simpanKaryawanBaru(e: React.FormEvent) {
    e.preventDefault();
    if (!navigator.onLine) return alert('Menambah karyawan baru membutuhkan koneksi internet.');
    const res = await fetch('/api/karyawan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formKry),
    });
    const json = await res.json();
    if (json.status === 'ok') {
      setFormKry({ id_karyawan: '', nama: '', pin: '1234', role: 'karyawan' });
      loadKaryawan();
      alert('Data karyawan tersimpan!');
    } else alert(json.message || 'Gagal menyimpan');
  }

  async function hapusKaryawan(id: string) {
    if (!navigator.onLine) return alert('Menghapus karyawan membutuhkan koneksi internet.');
    if (!confirm(`Hapus karyawan ${id}?`)) return;
    if ((await fetch(`/api/karyawan?id=${encodeURIComponent(id)}`, { method: 'DELETE' })).ok) loadKaryawan();
  }

  async function mulaiScanQR() {
    if (!gps) return alert('Tunggu lokasi GPS terkunci terlebih dahulu!');
    if (gps.jarak > MAX_RADIUS) return alert(`Absen ditolak! Jarak ${gps.jarak}m (maks ${MAX_RADIUS}m).`);
    setScanning(true);
    const { Html5Qrcode } = await import('html5-qrcode');
    const html5QrCode = new Html5Qrcode('qr-reader');
    scannerRef.current = html5QrCode;
    html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      async (decodedText) => {
        await html5QrCode.stop();
        setScanning(false);
        await prosesSimpanAbsen(decodedText);
      },
      () => {}
    ).catch(() => {
      setScanning(false);
      alert('Gagal membuka kamera.');
    });
  }

  async function prosesSimpanAbsen(qrId: string) {
    if (!user || !gps) return;
    const now = new Date();
    const tanggal = now.toISOString().slice(0, 10);
    const waktuScan = now.toTimeString().slice(0, 5);
    const [jJam, jMenit] = jadwalHariIni.split(':').map(Number);
    const [sJam, sMenit] = waktuScan.split(':').map(Number);
    const selisih = sJam * 60 + sMenit - (jJam * 60 + jMenit);
    const telatMenit = jenisAbsen === 'MASUK' && selisih > 0 ? selisih : 0;
    const status =
      jenisAbsen === 'KELUAR'
        ? 'Pulang'
        : telatMenit === 0
        ? 'Tepat Waktu'
        : telatMenit <= toleransiHariIni
        ? 'Toleransi'
        : 'Terlambat';

    const record: AbsenRecord = {
      id_log: `${user.id}-${tanggal}-${jenisAbsen}-${Date.now()}`,
      tanggal,
      id_karyawan: user.id,
      nama: user.nama,
      jenis: jenisAbsen,
      waktu_scan: waktuScan,
      jadwal_berangkat: jadwalHariIni,
      telat_menit: telatMenit,
      status,
      koordinat_gps: `${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}`,
      jarak_meter: gps.jarak,
      mode_rekam: navigator.onLine ? 'Online' : 'Offline-Sync',
      qr_id: qrId,
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
        });
        if (!res.ok) throw new Error();
        alert(`Absen ${jenisAbsen} berhasil (${status})!`);
      } catch {
        await db.put('queue', { ...record, mode_rekam: 'Offline-Sync' });
        setQueueCount((c) => c + 1);
      }
    } else {
      await db.put('queue', record);
      setQueueCount((c) => c + 1);
      alert(`Mode Offline: Absen ${jenisAbsen} tersimpan di HP dan otomatis terkirim saat online.`);
    }
  }

  async function handleFileJadwal(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const parsedRows: JadwalItem[] = [];

    if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
      const wb = XLSX.read(await file.arrayBuffer());
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
      for (const r of raw) {
        parsedRows.push({
          id_karyawan: String(r.ID_Karyawan || '').trim().toUpperCase(),
          nama: String(r.Nama_Karyawan || '').trim(),
          tanggal: String(r.Tanggal || '').trim(),
          jam_berangkat: String(r.Jam_Berangkat_Jadwal || '07:00').trim(),
          jam_pulang: String(r.Jam_Pulang_Jadwal || '17:00').trim(),
        });
      }
    } else if (file.name.endsWith('.pdf')) {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      let fullText = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const content = await (await pdf.getPage(i)).getTextContent();
        fullText += content.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n';
      }
      const regex = /([A-Z]+-\d+)\s+([A-Za-z\s]+?)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/g;
      let match;
      while ((match = regex.exec(fullText)) !== null) {
        parsedRows.push({
          id_karyawan: match[1].trim(),
          nama: match[2].trim(),
          tanggal: match[3].trim(),
          jam_berangkat: match[4].trim(),
          jam_pulang: '17:00',
        });
      }
    }

    if (parsedRows.length === 0) return alert('Tidak ada baris jadwal valid terbaca.');
    const db = await getLocalDB();
    const tx = db.transaction('jadwal', 'readwrite');
    for (const item of parsedRows) await tx.store.put(item);
    await tx.done;

    if (navigator.onLine) {
      await fetch('/api/jadwal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: parsedRows }),
      });
    }
    alert(`Berhasil mengimpor ${parsedRows.length} baris jadwal!`);
  }

  function getFilteredLogs() {
    const now = new Date();
    return logs.filter((l) => {
      const diffDays = (now.getTime() - new Date(l.tanggal).getTime()) / 86400000;
      if (filterLaporan === 'harian') return l.tanggal === now.toISOString().slice(0, 10);
      if (filterLaporan === 'mingguan') return diffDays <= 7;
      return diffDays <= 31;
    });
  }

  function exportLaporan(format: 'xlsx' | 'pdf' | 'csv') {
    const data = getFilteredLogs();
    if (format === 'xlsx' || format === 'csv') {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Laporan_Absensi');
      XLSX.writeFile(wb, `laporan-absensi-${filterLaporan}.${format}`);
    } else {
      const doc = new jsPDF();
      doc.text(`Laporan Absensi (${filterLaporan.toUpperCase()})`, 14, 15);
      autoTable(doc, {
        startY: 22,
        head: [['Tanggal', 'ID', 'Nama', 'Jenis', 'Scan', 'Telat', 'Status']],
        body: data.map((r) => [r.tanggal, r.id_karyawan, r.nama, r.jenis, r.waktu_scan, `${r.telat_menit}m`, r.status]),
      });
      doc.save(`laporan-absensi-${filterLaporan}.pdf`);
    }
  }

  return (
    <main className="max-w-4xl mx-auto p-4 space-y-6">
      <header className="bg-slate-900 text-white p-4 rounded-xl flex flex-wrap justify-between items-center gap-2">
        <div>
          <h1 className="font-bold text-lg">APLIKASI ABSENSI QR & GPS</h1>
          {user && <p className="text-xs text-slate-300">{user.nama} ({user.id}) • {userRole.toUpperCase()}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {installPrompt && (
            <button onClick={installAplikasiKeHP} className="bg-indigo-600 px-3 py-1 rounded text-xs font-bold">
              + Install Aplikasi
            </button>
          )}
          <span className={`px-3 py-1 rounded-full text-xs font-bold ${isOnline ? 'bg-emerald-600' : 'bg-amber-600'}`}>
            {isOnline ? 'ONLINE' : 'OFFLINE'} • ANTREAN: {queueCount}
          </span>
          {queueCount > 0 && isOnline && (
            <button onClick={syncOfflineQueue} className="bg-blue-600 px-3 py-1 rounded text-xs font-bold">
              Sync
            </button>
          )}
          {user && (
            <button onClick={handleLogout} className="bg-red-600 px-3 py-1 rounded text-xs">
              Keluar
            </button>
          )}
        </div>
      </header>

      {!user ? (
        <form onSubmit={handleLoginDenganPin} className="bg-white p-6 rounded-xl shadow space-y-4">
          <h2 className="font-bold text-lg">Login Karyawan / Admin</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input value={inpId} onChange={(e) => setInpId(e.target.value)} placeholder="ID (KRY-001 / ADM-001)" className="border p-2 rounded" />
            <input type="password" value={inpPin} onChange={(e) => setInpPin(e.target.value)} placeholder="PIN" className="border p-2 rounded" />
            <button type="submit" className="bg-blue-800 text-white font-bold py-2 px-4 rounded">Masuk Aplikasi</button>
          </div>
        </form>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <section className="bg-white p-5 rounded-xl shadow space-y-3">
              <h2 className="font-bold text-base">1. Scan QR & GPS Realtime</h2>
              <p className="text-sm">Jadwal Masuk: <strong>{jadwalHariIni}</strong></p>
              <p className="text-sm">
                GPS:{' '}
                {gps ? (
                  <span className={gps.jarak <= MAX_RADIUS ? 'text-emerald-700 font-semibold' : 'text-red-600 font-semibold'}>
                    Jarak {gps.jarak}m ({gps.jarak <= MAX_RADIUS ? 'Aman' : 'Di Luar Radius'})
                  </span>
                ) : (
                  'Mengunci GPS...'
                )}
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setJenisAbsen('MASUK')} className={`flex-1 py-2 rounded font-bold text-xs ${jenisAbsen === 'MASUK' ? 'bg-blue-800 text-white' : 'bg-slate-200'}`}>MASUK</button>
                <button type="button" onClick={() => setJenisAbsen('KELUAR')} className={`flex-1 py-2 rounded font-bold text-xs ${jenisAbsen === 'KELUAR' ? 'bg-blue-800 text-white' : 'bg-slate-200'}`}>KELUAR</button>
              </div>
              <div id="qr-reader" className="w-full rounded overflow-hidden" />
              {!scanning && <button onClick={mulaiScanQR} className="w-full bg-emerald-700 text-white font-bold py-2.5 rounded-lg">Buka Kamera Scan QR</button>}
            </section>

            <section className="bg-white p-5 rounded-xl shadow space-y-3">
              <h2 className="font-bold text-base">2. Input Jadwal (.XLSX / .PDF)</h2>
              <input type="file" accept=".xlsx,.xls,.pdf" onChange={handleFileJadwal} className="block w-full text-sm border p-2 rounded" />
            </section>
          </div>

          <section className="bg-white p-5 rounded-xl shadow space-y-4">
            <div className="flex flex-wrap justify-between items-center gap-2">
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-base">3. Laporan:</h2>
                <select value={filterLaporan} onChange={(e) => setFilterLaporan(e.target.value as 'harian' | 'mingguan' | 'bulanan')} className="border p-1.5 rounded text-sm">
                  <option value="harian">Harian</option>
                  <option value="mingguan">Mingguan</option>
                  <option value="bulanan">Bulanan</option>
                </select>
              </div>
              <div className="flex gap-2">
                <button onClick={() => exportLaporan('xlsx')} className="bg-emerald-700 text-white px-3 py-1.5 rounded text-xs font-bold">XLSX</button>
                <button onClick={() => exportLaporan('pdf')} className="bg-red-700 text-white px-3 py-1.5 rounded text-xs font-bold">PDF</button>
                <button onClick={() => exportLaporan('csv')} className="bg-slate-800 text-white px-3 py-1.5 rounded text-xs font-bold">CSV</button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left border">
                <thead className="bg-slate-800 text-white">
                  <tr><th className="p-2">Tanggal</th><th className="p-2">Nama</th><th className="p-2">Jenis</th><th className="p-2">Scan</th><th className="p-2">Telat</th><th className="p-2">Status</th><th className="p-2">Mode</th></tr>
                </thead>
                <tbody>
                  {getFilteredLogs().map((row) => (
                    <tr key={row.id_log} className="border-b">
                      <td className="p-2">{row.tanggal}</td><td className="p-2">{row.nama}</td><td className="p-2">{row.jenis}</td>
                      <td className="p-2">{row.waktu_scan}</td><td className="p-2">{row.telat_menit}m</td><td className="p-2">{row.status}</td><td className="p-2">{row.mode_rekam}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {userRole === 'admin' && (
            <section className="bg-white p-6 rounded-xl shadow space-y-4 border-t-4 border-blue-800">
              <h2 className="font-bold text-lg text-blue-900">4. Panel Admin: Data Karyawan</h2>
              <form onSubmit={simpanKaryawanBaru} className="grid grid-cols-1 md:grid-cols-5 gap-2">
                <input value={formKry.id_karyawan} onChange={(e) => setFormKry({ ...formKry, id_karyawan: e.target.value })} placeholder="ID (KRY-005)" className="border p-2 rounded text-sm" required />
                <input value={formKry.nama} onChange={(e) => setFormKry({ ...formKry, nama: e.target.value })} placeholder="Nama Lengkap" className="border p-2 rounded text-sm" required />
                <input value={formKry.pin} onChange={(e) => setFormKry({ ...formKry, pin: e.target.value })} placeholder="PIN" className="border p-2 rounded text-sm" required />
                <select value={formKry.role} onChange={(e) => setFormKry({ ...formKry, role: e.target.value })} className="border p-2 rounded text-sm">
                  <option value="karyawan">Karyawan</option>
                  <option value="admin">Admin</option>
                </select>
                <button type="submit" className="bg-blue-800 text-white font-bold py-2 px-4 rounded text-sm">Simpan</button>
              </form>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border">
                  <thead className="bg-slate-800 text-white">
                    <tr><th className="p-2">ID</th><th className="p-2">Nama</th><th className="p-2">PIN</th><th className="p-2">Role</th><th className="p-2">Aksi</th></tr>
                  </thead>
                  <tbody>
                    {daftarKaryawan.map((k) => (
                      <tr key={k.id_karyawan} className="border-b">
                        <td className="p-2 font-mono font-bold">{k.id_karyawan}</td><td className="p-2">{k.nama}</td><td className="p-2">{k.pin}</td><td className="p-2 uppercase">{k.role}</td>
                        <td className="p-2 flex gap-1">
                          <button type="button" onClick={() => setFormKry({ id_karyawan: k.id_karyawan, nama: k.nama, pin: k.pin, role: k.role })} className="bg-amber-500 text-white px-2 py-1 rounded">Edit</button>
                          {k.id_karyawan !== user.id && <button type="button" onClick={() => hapusKaryawan(k.id_karyawan)} className="bg-red-600 text-white px-2 py-1 rounded">Hapus</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
