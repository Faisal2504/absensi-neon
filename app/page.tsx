"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

interface SettingsData {
  office_name: string;
  qr_code: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  shift_start: string;
  late_tolerance: number;
}
interface Employee {
  id: number;
  emp_code: string;
  full_name: string;
  role: "ADMIN" | "STAFF";
  department: string;
  pin_code: string;
  shift_start: string;
}
interface AttendanceRow {
  id?: number;
  client_uuid: string;
  emp_code: string;
  full_name: string;
  entry_type: "MASUK" | "KELUAR";
  date_str: string;
  time_str: string;
  is_late: boolean;
  late_minutes: number;
  distance_meters: number;
  status_label: string;
  sync_mode: string;
  notes: string;
}

const Q_KEY = "allin_offline_q_v1";
const U_KEY = "allin_user_v1";

const wibDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
const wibTime = () =>
  new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" });

function distMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3, p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180, dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export default function AllInAttendanceSystem() {
  const [user, setUser] = useState<Employee | null>(null);
  const [loginCode, setLoginCode] = useState("ADM-001");
  const [loginPin, setLoginPin] = useState("0000");

  const [tab, setTab] = useState<"monitor" | "absen" | "karyawan" | "sistem">("monitor");
  const [online, setOnline] = useState(true);
  const [autoLive, setAutoLive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busyPunch, setBusyPunch] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string>("-");

  const [settings, setSettings] = useState<SettingsData>({
    office_name: "Kantor Utama MPI-BTG",
    qr_code: "ABSENSI-KANTOR-MPI-BTG",
    latitude: -6.6167,
    longitude: 110.6667,
    radius_meters: 150,
    shift_start: "07:00",
    late_tolerance: 10,
  });
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [queue, setQueue] = useState<AttendanceRow[]>([]);

  const [punchType, setPunchType] = useState<"MASUK" | "KELUAR">("MASUK");
  const [qrInput, setQrInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);

  const [filterDate, setFilterDate] = useState(wibDate);
  const [filterEmp, setFilterEmp] = useState("ALL");
  const [editAtt, setEditAtt] = useState<AttendanceRow | null>(null);

  const [empForm, setEmpForm] = useState({ id: 0, emp_code: "", full_name: "", role: "STAFF", department: "Operasional", pin_code: "1234", shift_start: "07:00" });
  const [cfgForm, setCfgForm] = useState<SettingsData>(settings);

  const toast = useCallback((text: string) => {
    setMsg(text);
    setTimeout(() => setMsg(null), 3500);
  }, []);

  const syncOffline = useCallback(async (q: AttendanceRow[]) => {
    if (!navigator.onLine || q.length === 0) return;
    const res = await fetch("/api/all-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "RECORD_PUNCH", payload: { items: q } }),
    });
    const d = await res.json();
    if (d.ok) {
      localStorage.removeItem(Q_KEY);
      setQueue([]);
      toast(`${q.length} absen offline tersinkron ke server!`);
    }
  }, [toast]);

  const refreshServer = useCallback(async (silent = false) => {
    if (!navigator.onLine) return;
    if (!silent) setLoading(true);
    try {
      const rawQ = localStorage.getItem(Q_KEY);
      const pending: AttendanceRow[] = rawQ ? JSON.parse(rawQ) : [];
      if (pending.length > 0) await syncOffline(pending);
      const res = await fetch(`/api/all-in?t=${Date.now()}`, { cache: "no-store" });
      const d = await res.json();
      if (d.ok) {
        setSettings(d.settings);
        if (!silent) setCfgForm(d.settings);
        setEmployees(d.employees || []);
        setAttendance(d.attendance || []);
        setLastSync(wibTime());
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [syncOffline]);

  useEffect(() => {
    setOnline(navigator.onLine);
    const onOn = () => { setOnline(true); refreshServer(); };
    const onOff = () => setOnline(false);
    const onFocus = () => refreshServer(true);
    window.addEventListener("online", onOn);
    window.addEventListener("offline", onOff);
    window.addEventListener("focus", onFocus);
    const savedU = localStorage.getItem(U_KEY);
    if (savedU) setUser(JSON.parse(savedU));
    const savedQ = localStorage.getItem(Q_KEY);
    if (savedQ) setQueue(JSON.parse(savedQ));
    refreshServer();
    return () => {
      window.removeEventListener("online", onOn);
      window.removeEventListener("offline", onOff);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshServer]);

  useEffect(() => {
    if (!autoLive || !online) return;
    const timer = setInterval(() => refreshServer(true), 3000);
    return () => clearInterval(timer);
  }, [autoLive, online, refreshServer]);

  const checkGps = useCallback(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (p) => setGps({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  useEffect(() => { checkGps(); }, [checkGps]);

  const stopScan = () => {
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    setScanning(false);
  };

  const distance = useMemo(() => {
    if (!gps) return null;
    return distMeters(gps.lat, gps.lng, Number(settings.latitude), Number(settings.longitude));
  }, [gps, settings]);

  const pushPunchToDb = async (targetEmp: { emp_code: string; full_name: string }, type: "MASUK" | "KELUAR", modeLabel: string) => {
    if (busyPunch) return;
    setBusyPunch(true);
    const row: AttendanceRow = {
      client_uuid: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      emp_code: targetEmp.emp_code,
      full_name: targetEmp.full_name,
      entry_type: type,
      date_str: wibDate(),
      time_str: wibTime(),
      is_late: false,
      late_minutes: 0,
      distance_meters: distance ?? 0,
      status_label: "VALID",
      sync_mode: navigator.onLine ? modeLabel : "OFFLINE",
      notes: "",
    };
    try {
      if (navigator.onLine) {
        const res = await fetch("/api/all-in", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "RECORD_PUNCH", payload: row }),
        });
        const d = await res.json();
        if (d.ok) {
          await refreshServer(true);
          toast(`Tersimpan Real-Time: ${targetEmp.full_name} (${type} ${row.time_str})`);
        } else {
          toast(d.error || "Gagal menyimpan ke server");
        }
      } else {
        const nextQ = [row, ...queue];
        setQueue(nextQ);
        localStorage.setItem(Q_KEY, JSON.stringify(nextQ));
        toast(`Offline: ${targetEmp.full_name} (${type}) masuk antrean`);
      }
    } finally {
      setBusyPunch(false);
    }
  };

  const submitQrPunch = async (code: string) => {
    if (!user) return;
    if (code.trim().toUpperCase() !== settings.qr_code.trim().toUpperCase()) {
      toast(`QR salah! Gunakan QR resmi: ${settings.qr_code}`);
      return;
    }
    if (distance !== null && distance > settings.radius_meters && user.role !== "ADMIN") {
      toast(`Di luar radius GPS (${distance}m > ${settings.radius_meters}m)`);
      return;
    }
    setQrInput("");
    stopScan();
    await pushPunchToDb(user, punchType, "QR-GPS");
  };

  const startScan = async () => {
    try {
      setScanning(true);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (videoRef.current) videoRef.current.srcObject = stream;
      const BD = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
      if (BD) {
        const detector = new BD({ formats: ["qr_code"] });
        const tick = async () => {
          if (!videoRef.current || !videoRef.current.srcObject) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0 && codes[0].rawValue) {
              submitQrPunch(codes[0].rawValue);
              return;
            }
          } catch {}
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    } catch {
      setScanning(false);
      toast("Kamera diblokir, silakan ketik kode QR manual.");
    }
  };

  const apiPost = async (action: string, payload: unknown, okMsg: string) => {
    const res = await fetch("/api/all-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
    });
    const d = await res.json();
    if (d.ok) {
      toast(okMsg);
      await refreshServer();
    } else {
      toast(d.error || "Gagal menyimpan");
    }
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const found = employees.find(
      (x) => x.emp_code.toUpperCase() === loginCode.trim().toUpperCase() && x.pin_code === loginPin.trim()
    );
    if (found) {
      setUser(found);
      localStorage.setItem(U_KEY, JSON.stringify(found));
    } else if (loginCode.toUpperCase() === "ADM-001" && loginPin === "0000") {
      const fallback: Employee = { id: 1, emp_code: "ADM-001", full_name: "Admin Operasional", role: "ADMIN", department: "Manajemen", pin_code: "0000", shift_start: "07:00" };
      setUser(fallback);
      localStorage.setItem(U_KEY, JSON.stringify(fallback));
    } else {
      toast("ID Karyawan atau PIN salah!");
    }
  };

  const today = wibDate();
  const todayRows = useMemo(() => attendance.filter((a) => a.date_str === today), [attendance, today]);
  const stats = useMemo(() => ({
    masuk: todayRows.filter((r) => r.entry_type === "MASUK").length,
    telat: todayRows.filter((r) => r.entry_type === "MASUK" && r.is_late).length,
    keluar: todayRows.filter((r) => r.entry_type === "KELUAR").length,
  }), [todayRows]);

  const filteredAtt = useMemo(() => {
    return attendance.filter((r) => {
      if (filterDate && r.date_str !== filterDate) return false;
      if (filterEmp !== "ALL" && r.emp_code !== filterEmp) return false;
      return true;
    });
  }, [attendance, filterDate, filterEmp]);

  const exportExcel = () => {
    const html = `<table border="1"><tr><th>Tanggal</th><th>ID</th><th>Nama</th><th>Jenis</th><th>Jam</th><th>Telat</th><th>Status</th><th>Mode</th></tr>${filteredAtt
      .map((r) => `<tr><td>${r.date_str}</td><td>${r.emp_code}</td><td>${r.full_name}</td><td>${r.entry_type}</td><td>${r.time_str}</td><td>${r.is_late ? r.late_minutes + "m" : "Tepat"}</td><td>${r.status_label}</td><td>${r.sync_mode}</td></tr>`)
      .join("")}</table>`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type: "application/vnd.ms-excel" }));
    a.download = `Laporan_Absensi_${filterDate || "Semua"}.xls`;
    a.click();
  };

  const handleCsvImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const lines = String(reader.result || "").split(/\r?\n/).filter(Boolean);
      const rows = lines.slice(1).map((line) => {
        const [emp_code, full_name, department, pin_code, shift_start] = line.split(/[,;]/);
        return { emp_code, full_name, department, pin_code, shift_start };
      });
      apiPost("IMPORT_EMPLOYEES", { rows }, `${rows.length} data CSV diimpor!`);
    };
    reader.readAsText(file);
  };

  const isAdmin = user?.role === "ADMIN";
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(settings.qr_code)}`;

  if (!user) {
    return (
      <div style={{ minHeight: "100vh", background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "system-ui, sans-serif" }}>
        <form onSubmit={handleLogin} style={{ background: "#fff", padding: 24, borderRadius: 16, width: "100%", maxWidth: 380, boxShadow: "0 4px 16px rgba(0,0,0,0.08)" }}>
          <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>APLIKASI ABSENSI QR & GPS</h2>
          <p style={{ margin: "0 0 16px", fontSize: 12, color: "#64748b" }}>Login Admin (ADM-001 / 0000) atau ID Karyawan</p>
          {msg && <div style={{ background: "#fee2e2", color: "#b91c1c", padding: 8, borderRadius: 8, fontSize: 12, marginBottom: 10 }}>{msg}</div>}
          <input value={loginCode} onChange={(e) => setLoginCode(e.target.value)} placeholder="ID Karyawan (ADM-001)" style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #cbd5e1", marginBottom: 10 }} />
          <input type="password" value={loginPin} onChange={(e) => setLoginPin(e.target.value)} placeholder="PIN" style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #cbd5e1", marginBottom: 14 }} />
          <button type="submit" style={{ width: "100%", padding: 12, borderRadius: 10, border: "none", background: "#0f172a", color: "#fff", fontWeight: 700, cursor: "pointer" }}>MASUK SISTEM</button>
        </form>
      </div>
    );
  }

  return (
    <div className="wrap">
      <style>{`
        * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
        body { margin: 0; background: #eef2f6; color: #0f172a; }
        .wrap { max-width: 1120px; margin: 0 auto; padding: 12px; }
        .top { background: #0f172a; color: #fff; padding: 16px; border-radius: 16px; margin-bottom: 12px; }
        .badge { display: inline-block; padding: 4px 10px; border-radius: 99px; font-size: 11px; font-weight: 700; }
        .btn { border: none; border-radius: 10px; padding: 9px 14px; font-size: 12px; font-weight: 700; cursor: pointer; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 12px; }
        .tab { background: #fff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 10px 6px; font-size: 12px; font-weight: 700; cursor: pointer; }
        .tab.act { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
        .card { background: #fff; border-radius: 16px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
        .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; text-align: center; }
        .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
        .inp { width: 100%; padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 13px; background: #fff; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { background: #0f172a; color: #fff; text-align: left; padding: 9px 8px; white-space: nowrap; }
        td { padding: 8px; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
        .toast { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); background: #0f172a; color: #fff; padding: 10px 18px; border-radius: 99px; font-size: 12px; font-weight: 700; z-index: 60; }
        .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 50; }
        @media print { .no-print { display: none !important; } }
      `}</style>

      {msg && <div className="toast">{msg}</div>}

      <div className="top no-print">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>APLIKASI ABSENSI QR & GPS</div>
            <div style={{ fontSize: 12, color: "#94a3b8" }}>{user.full_name} ({user.emp_code}) • Sync: {lastSync} WIB</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="badge" style={{ background: online ? "#16a34a" : "#d97706" }}>
              {online ? `ONLINE • ANTREAN: ${queue.length}` : `OFFLINE • ANTREAN: ${queue.length}`}
            </span>
            <button className="btn" style={{ background: autoLive ? "#059669" : "#475569", color: "#fff" }} onClick={() => setAutoLive(!autoLive)}>
              {autoLive ? "LIVE 3d: ON" : "LIVE: OFF"}
            </button>
            <button className="btn" style={{ background: "#2563eb", color: "#fff" }} onClick={() => refreshServer()}>
              {loading ? "Sync..." : "Refresh Server"}
            </button>
            <button className="btn" style={{ background: "#dc2626", color: "#fff" }} onClick={() => { localStorage.removeItem(U_KEY); setUser(null); }}>
              Keluar
            </button>
          </div>
        </div>
      </div>

      <div className="tabs no-print">
        <button className={`tab ${tab === "monitor" ? "act" : ""}`} onClick={() => setTab("monitor")}>Monitoring & Absen Langsung</button>
        <button className={`tab ${tab === "absen" ? "act" : ""}`} onClick={() => setTab("absen")}>Scan QR & GPS</button>
        {isAdmin && <button className={`tab ${tab === "karyawan" ? "act" : ""}`} onClick={() => setTab("karyawan")}>Edit Karyawan ({employees.length})</button>}
        {isAdmin && <button className={`tab ${tab === "sistem" ? "act" : ""}`} onClick={() => setTab("sistem")}>Edit Sistem, QR & GPS</button>}
      </div>

      {tab === "monitor" && (
        <>
          <div className="card no-print" style={{ border: "2px solid #2563eb" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <strong>Absen Real-Time Saya ({user.full_name})</strong>
              <span className="badge" style={{ background: "#dbeafe", color: "#1e40af" }}>LANGSUNG KE DATABASE</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button
                className="btn"
                disabled={busyPunch}
                style={{ background: "#16a34a", color: "#fff", padding: 14, fontSize: 13 }}
                onClick={() => pushPunchToDb(user, "MASUK", isAdmin ? "ADMIN-REALTIME" : "HP-REALTIME")}
              >
                + ABSEN MASUK SEKARANG
              </button>
              <button
                className="btn"
                disabled={busyPunch}
                style={{ background: "#dc2626", color: "#fff", padding: 14, fontSize: 13 }}
                onClick={() => pushPunchToDb(user, "KELUAR", isAdmin ? "ADMIN-REALTIME" : "HP-REALTIME")}
              >
                + ABSEN KELUAR SEKARANG
              </button>
            </div>
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <strong>Monitoring Kehadiran Hari Ini ({today})</strong>
              <span className="badge" style={{ background: "#dcfce7", color: "#15803d" }}>LIVE SERVER</span>
            </div>
            <div className="grid3">
              <div style={{ background: "#eff6ff", padding: 12, borderRadius: 12 }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#1d4ed8" }}>{stats.masuk}</div>
                <div style={{ fontSize: 11, color: "#475569" }}>Absen Masuk</div>
              </div>
              <div style={{ background: "#fefce8", padding: 12, borderRadius: 12 }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#ca8a04" }}>{stats.telat}</div>
                <div style={{ fontSize: 11, color: "#475569" }}>Terlambat</div>
              </div>
              <div style={{ background: "#ecfdf5", padding: 12, borderRadius: 12 }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#059669" }}>{stats.keluar}</div>
                <div style={{ fontSize: 11, color: "#475569" }}>Absen Keluar</div>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
                Status Realtime Semua Karyawan {isAdmin ? "(Klik Masuk/Keluar untuk absenkan langsung)" : ""}:
              </div>
              <div className="grid2">
                {employees.map((e) => {
                  const empLogs = todayRows.filter((r) => r.emp_code === e.emp_code);
                  const m = empLogs.find((r) => r.entry_type === "MASUK");
                  const k = empLogs.find((r) => r.entry_type === "KELUAR");
                  return (
                    <div key={e.id} style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{e.full_name}</div>
                          <div style={{ fontSize: 11, color: "#64748b" }}>{e.emp_code} • {e.department}</div>
                        </div>
                        <div style={{ textAlign: "right", fontSize: 11 }}>
                          <div style={{ fontWeight: 700, color: m ? (m.is_late ? "#dc2626" : "#16a34a") : "#94a3b8" }}>
                            {m ? `Masuk ${m.time_str}${m.is_late ? ` (Telat ${m.late_minutes}m)` : ""}` : "Belum Masuk"}
                          </div>
                          <div style={{ color: k ? "#2563eb" : "#94a3b8" }}>{k ? `Keluar ${k.time_str}` : "Belum Keluar"}</div>
                        </div>
                      </div>
                      {isAdmin && (
                        <div className="no-print" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8, paddingTop: 8, borderTop: "1px dashed #e2e8f0" }}>
                          <button
                            className="btn"
                            disabled={busyPunch}
                            style={{ background: "#dcfce7", color: "#15803d", padding: "6px 8px", fontSize: 11 }}
                            onClick={() => pushPunchToDb(e, "MASUK", "ADMIN-KLIK")}
                          >
                            + Masuk ({e.emp_code})
                          </button>
                          <button
                            className="btn"
                            disabled={busyPunch}
                            style={{ background: "#fee2e2", color: "#b91c1c", padding: "6px 8px", fontSize: 11 }}
                            onClick={() => pushPunchToDb(e, "KELUAR", "ADMIN-KLIK")}
                          >
                            + Keluar ({e.emp_code})
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }} className="no-print">
              <strong>Laporan & Edit Data Absensi</strong>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {isAdmin && (
                  <button className="btn" style={{ background: "#2563eb", color: "#fff" }} onClick={() => setEditAtt({ client_uuid: "", emp_code: employees[0]?.emp_code || "ADM-001", full_name: employees[0]?.full_name || "Admin", entry_type: "MASUK", date_str: today, time_str: "07:00", is_late: false, late_minutes: 0, distance_meters: 0, status_label: "VALID", sync_mode: "ADMIN", notes: "" })}>
                    + Input Jam Manual
                  </button>
                )}
                <button className="btn" style={{ background: "#059669", color: "#fff" }} onClick={exportExcel}>Download XLSX</button>
                <button className="btn" style={{ background: "#dc2626", color: "#fff" }} onClick={() => window.print()}>Print / PDF</button>
              </div>
            </div>

            <div className="grid2 no-print" style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 6 }}>
                <input type="date" className="inp" value={filterDate} onChange={(e) => setFilterDate(e.target.value)} />
                <button className="btn" style={{ background: "#e2e8f0" }} onClick={() => setFilterDate("")}>Semua Tgl</button>
              </div>
              <select className="inp" value={filterEmp} onChange={(e) => setFilterEmp(e.target.value)}>
                <option value="ALL">Semua Karyawan</option>
                {employees.map((e) => <option key={e.id} value={e.emp_code}>{e.full_name} ({e.emp_code})</option>)}
              </select>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Tanggal</th>
                    <th>Nama</th>
                    <th>Jenis</th>
                    <th>Jam Scan</th>
                    <th>Telat</th>
                    <th>Status</th>
                    <th>Mode</th>
                    {isAdmin && <th className="no-print">Aksi Edit</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredAtt.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: "center", color: "#94a3b8", padding: 16 }}>Belum ada data absensi</td></tr>
                  ) : filteredAtt.map((r) => (
                    <tr key={r.id || r.client_uuid}>
                      <td>{r.date_str}</td>
                      <td><strong>{r.full_name}</strong><br /><span style={{ fontSize: 10, color: "#64748b" }}>{r.emp_code}</span></td>
                      <td><span className="badge" style={{ background: r.entry_type === "MASUK" ? "#dbeafe" : "#fce7f3", color: r.entry_type === "MASUK" ? "#1e40af" : "#9d174d" }}>{r.entry_type}</span></td>
                      <td><strong>{r.time_str}</strong></td>
                      <td style={{ color: r.is_late ? "#dc2626" : "#16a34a", fontWeight: 700 }}>{r.is_late ? `${r.late_minutes} mnt` : "Tepat"}</td>
                      <td>{r.status_label}</td>
                      <td>{r.sync_mode}</td>
                      {isAdmin && (
                        <td className="no-print">
                          <button className="btn" style={{ background: "#f59e0b", color: "#fff", padding: "5px 8px", marginRight: 4 }} onClick={() => setEditAtt(r)}>Edit</button>
                          {r.id && <button className="btn" style={{ background: "#ef4444", color: "#fff", padding: "5px 8px" }} onClick={() => apiPost("DELETE_ATTENDANCE", { id: r.id }, "Absensi dihapus")}>Hapus</button>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === "absen" && (
        <div className="grid2">
          <div className="card">
            <strong>1. Scan QR & GPS Realtime</strong>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>Jadwal Masuk: <strong>{settings.shift_start}</strong> (Toleransi {settings.late_tolerance} mnt)</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: distance !== null && distance <= settings.radius_meters ? "#16a34a" : "#d97706", margin: "6px 0 12px" }}>
              GPS: {distance !== null ? `Jarak ${distance}m (${distance <= settings.radius_meters ? "Aman" : "Di Luar Radius"})` : "Mencari GPS..."}
              <button className="btn" style={{ marginLeft: 8, padding: "4px 8px", background: "#f1f5f9" }} onClick={checkGps}>Cek GPS</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <button className="btn" style={{ background: punchType === "MASUK" ? "#1d4ed8" : "#f1f5f9", color: punchType === "MASUK" ? "#fff" : "#0f172a", padding: 12 }} onClick={() => setPunchType("MASUK")}>MASUK</button>
              <button className="btn" style={{ background: punchType === "KELUAR" ? "#1d4ed8" : "#f1f5f9", color: punchType === "KELUAR" ? "#fff" : "#0f172a", padding: 12 }} onClick={() => setPunchType("KELUAR")}>KELUAR</button>
            </div>
            {!scanning ? (
              <button className="btn" style={{ width: "100%", background: "#047857", color: "#fff", padding: 12, marginBottom: 10 }} onClick={startScan}>Buka Kamera Scan QR</button>
            ) : (
              <div style={{ textAlign: "center", marginBottom: 10 }}>
                <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", maxWidth: 260, borderRadius: 12, background: "#000" }} />
                <br />
                <button className="btn" style={{ background: "#dc2626", color: "#fff", marginTop: 6 }} onClick={stopScan}>Tutup Kamera</button>
              </div>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input className="inp" placeholder={`Input kode QR manual (${settings.qr_code})`} value={qrInput} onChange={(e) => setQrInput(e.target.value)} />
              <button className="btn" style={{ background: "#0f172a", color: "#fff" }} onClick={() => submitQrPunch(qrInput)}>Kirim</button>
            </div>
          </div>

          <div className="card" style={{ textAlign: "center" }}>
            <strong>QR Code Resmi ({settings.office_name})</strong>
            <p style={{ fontSize: 12, color: "#64748b" }}>Radius GPS: Maks. {settings.radius_meters} meter</p>
            <img src={qrUrl} alt="QR Kantor" style={{ width: 200, height: 200, border: "1px solid #e2e8f0", borderRadius: 12, padding: 8 }} />
            <div style={{ fontWeight: 800, marginTop: 8 }}>{settings.qr_code}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
              <a href={qrUrl} download={`${settings.qr_code}.png`} target="_blank" rel="noreferrer" className="btn" style={{ background: "#047857", color: "#fff", textDecoration: "none" }}>Download PNG</a>
              <button className="btn" style={{ background: "#0f172a", color: "#fff" }} onClick={() => window.print()}>Cetak QR</button>
            </div>
          </div>
        </div>
      )}

      {tab === "karyawan" && isAdmin && (
        <div className="grid2">
          <div className="card">
            <strong>{empForm.id ? `Edit Karyawan (${empForm.emp_code})` : "Tambah Karyawan Baru"}</strong>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              <input className="inp" placeholder="ID Karyawan (contoh: KRY-001)" value={empForm.emp_code} onChange={(e) => setEmpForm({ ...empForm, emp_code: e.target.value })} />
              <input className="inp" placeholder="Nama Lengkap" value={empForm.full_name} onChange={(e) => setEmpForm({ ...empForm, full_name: e.target.value })} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <select className="inp" value={empForm.role} onChange={(e) => setEmpForm({ ...empForm, role: e.target.value })}>
                  <option value="STAFF">STAFF (Karyawan)</option>
                  <option value="ADMIN">ADMIN (Full Akses)</option>
                </select>
                <input className="inp" placeholder="Divisi / Jabatan" value={empForm.department} onChange={(e) => setEmpForm({ ...empForm, department: e.target.value })} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input className="inp" placeholder="PIN Login (4 digit)" value={empForm.pin_code} onChange={(e) => setEmpForm({ ...empForm, pin_code: e.target.value })} />
                <input type="time" className="inp" value={empForm.shift_start} onChange={(e) => setEmpForm({ ...empForm, shift_start: e.target.value })} />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" style={{ flex: 1, background: "#1d4ed8", color: "#fff", padding: 12 }} onClick={() => { apiPost("SAVE_EMPLOYEE", empForm, "Data karyawan tersimpan!"); setEmpForm({ id: 0, emp_code: "", full_name: "", role: "STAFF", department: "Operasional", pin_code: "1234", shift_start: "07:00" }); }}>
                  {empForm.id ? "Simpan Perubahan" : "+ Simpan Karyawan"}
                </button>
                {empForm.id !== 0 && (
                  <button className="btn" style={{ background: "#e2e8f0" }} onClick={() => setEmpForm({ id: 0, emp_code: "", full_name: "", role: "STAFF", department: "Operasional", pin_code: "1234", shift_start: "07:00" })}>Batal</button>
                )}
              </div>
              <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 10, marginTop: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Import Massal Karyawan & Jadwal (.CSV)</div>
                <input type="file" accept=".csv" onChange={handleCsvImport} style={{ fontSize: 12 }} />
              </div>
            </div>
          </div>

          <div className="card">
            <strong>Daftar Karyawan di Server</strong>
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table>
                <thead>
                  <tr><th>ID</th><th>Nama</th><th>Role</th><th>PIN</th><th>Shift</th><th>Aksi</th></tr>
                </thead>
                <tbody>
                  {employees.map((e) => (
                    <tr key={e.id}>
                      <td><strong>{e.emp_code}</strong></td>
                      <td>{e.full_name}<br /><span style={{ fontSize: 10, color: "#64748b" }}>{e.department}</span></td>
                      <td>{e.role}</td>
                      <td>{e.pin_code}</td>
                      <td>{e.shift_start}</td>
                      <td>
                        <button className="btn" style={{ background: "#f59e0b", color: "#fff", padding: "5px 8px", marginRight: 4 }} onClick={() => setEmpForm({ id: e.id, emp_code: e.emp_code, full_name: e.full_name, role: e.role, department: e.department, pin_code: e.pin_code, shift_start: e.shift_start })}>Edit</button>
                        {e.emp_code !== "ADM-001" && (
                          <button className="btn" style={{ background: "#ef4444", color: "#fff", padding: "5px 8px" }} onClick={() => apiPost("DELETE_EMPLOYEE", { id: e.id }, "Karyawan dihapus")}>Hapus</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === "sistem" && isAdmin && (
        <div className="card" style={{ maxWidth: 600 }}>
          <strong>Edit Pengaturan Sistem, QR Code & Radius GPS</strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
            <label style={{ fontSize: 12 }}>Nama Kantor / Lokasi
              <input className="inp" value={cfgForm.office_name} onChange={(e) => setCfgForm({ ...cfgForm, office_name: e.target.value })} />
            </label>
            <label style={{ fontSize: 12 }}>Kode QR Resmi Kantor
              <input className="inp" value={cfgForm.qr_code} onChange={(e) => setCfgForm({ ...cfgForm, qr_code: e.target.value })} />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <label style={{ fontSize: 12 }}>Latitude Kantor
                <input className="inp" value={cfgForm.latitude} onChange={(e) => setCfgForm({ ...cfgForm, latitude: Number(e.target.value) })} />
              </label>
              <label style={{ fontSize: 12 }}>Longitude Kantor
                <input className="inp" value={cfgForm.longitude} onChange={(e) => setCfgForm({ ...cfgForm, longitude: Number(e.target.value) })} />
              </label>
            </div>
            {gps && (
              <button className="btn" style={{ background: "#dcfce7", color: "#15803d" }} onClick={() => setCfgForm({ ...cfgForm, latitude: gps.lat, longitude: gps.lng })}>
                Gunakan Titik GPS Lokasi Saya Sekarang ({gps.lat.toFixed(5)}, {gps.lng.toFixed(5)})
              </button>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <label style={{ fontSize: 12 }}>Radius GPS (meter)
                <input type="number" className="inp" value={cfgForm.radius_meters} onChange={(e) => setCfgForm({ ...cfgForm, radius_meters: Number(e.target.value) })} />
              </label>
              <label style={{ fontSize: 12 }}>Jam Masuk Default
                <input type="time" className="inp" value={cfgForm.shift_start} onChange={(e) => setCfgForm({ ...cfgForm, shift_start: e.target.value })} />
              </label>
              <label style={{ fontSize: 12 }}>Toleransi Telat (mnt)
                <input type="number" className="inp" value={cfgForm.late_tolerance} onChange={(e) => setCfgForm({ ...cfgForm, late_tolerance: Number(e.target.value) })} />
              </label>
            </div>
            <button className="btn" style={{ background: "#1d4ed8", color: "#fff", padding: 12 }} onClick={() => apiPost("SAVE_SETTINGS", cfgForm, "Pengaturan sistem diperbarui!")}>
              Simpan Semua Pengaturan Sistem
            </button>
          </div>
        </div>
      )}

      {editAtt && isAdmin && (
        <div className="modal" onClick={() => setEditAtt(null)}>
          <div className="card" style={{ width: "100%", maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <strong>{editAtt.id ? `Edit Absensi (${editAtt.full_name})` : "Tambah Absen Manual"}</strong>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              {!editAtt.id && (
                <select className="inp" value={editAtt.emp_code} onChange={(e) => {
                  const emp = employees.find((x) => x.emp_code === e.target.value);
                  setEditAtt({ ...editAtt, emp_code: e.target.value, full_name: emp?.full_name || e.target.value });
                }}>
                  {employees.map((e) => <option key={e.id} value={e.emp_code}>{e.full_name} ({e.emp_code})</option>)}
                </select>
              )}
              <select className="inp" value={editAtt.entry_type} onChange={(e) => setEditAtt({ ...editAtt, entry_type: e.target.value as "MASUK" | "KELUAR" })}>
                <option value="MASUK">MASUK</option>
                <option value="KELUAR">KELUAR</option>
              </select>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input type="date" className="inp" value={editAtt.date_str} onChange={(e) => setEditAtt({ ...editAtt, date_str: e.target.value })} />
                <input type="time" className="inp" value={editAtt.time_str} onChange={(e) => setEditAtt({ ...editAtt, time_str: e.target.value })} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <select className="inp" value={editAtt.is_late ? "1" : "0"} onChange={(e) => setEditAtt({ ...editAtt, is_late: e.target.value === "1" })}>
                  <option value="0">Tepat Waktu</option>
                  <option value="1">Terlambat</option>
                </select>
                <input type="number" className="inp" placeholder="Menit telat" value={editAtt.late_minutes} onChange={(e) => setEditAtt({ ...editAtt, late_minutes: Number(e.target.value) })} />
              </div>
              <input className="inp" placeholder="Status (VALID / IZIN / DINAS LUAR)" value={editAtt.status_label} onChange={(e) => setEditAtt({ ...editAtt, status_label: e.target.value })} />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" style={{ flex: 1, background: "#1d4ed8", color: "#fff" }} onClick={() => { apiPost("EDIT_ATTENDANCE", editAtt, "Data absensi diperbarui!"); setEditAtt(null); }}>Simpan</button>
                <button className="btn" style={{ background: "#e2e8f0" }} onClick={() => setEditAtt(null)}>Batal</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
