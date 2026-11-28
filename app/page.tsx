"use client";

import React, { useEffect, useState } from "react";

interface EmployeeRecord {
  id: number;
  emp_code: string;
  full_name: string;
  role: string;
  pin_code: string;
}

const DEFAULT_ADMIN_PIN = "0000";
const CACHE_KEY = "fast_absensi_pro_mfr_cache_v6";
const ADMIN_SESSION_KEY = "fast_absensi_pro_mfr_admin_ok_v6";
const STAFF_SESSION_KEY = "fast_absensi_pro_mfr_staff_ok_v6";
const STAFF_ID_KEY = "fast_absensi_pro_mfr_staff_id_v6";
const STAFF_DEVICE_LOCK_KEY = "fast_absensi_pro_mfr_lock_staff_v6";

const FALLBACK_STAFF: EmployeeRecord[] = [
  {
    id: 1,
    emp_code: "EMP-001",
    full_name: "Karyawan 01",
    role: "STAFF",
    pin_code: "1001",
  },
  {
    id: 2,
    emp_code: "EMP-002",
    full_name: "Karyawan 02",
    role: "STAFF",
    pin_code: "1002",
  },
];

export default function FastAbsensiProMfrPage() {
  const [roleActive, setRoleActive] = useState<"NONE" | "ADMIN" | "STAFF">("NONE");
  const [loginScreen, setLoginScreen] = useState<"PICK" | "ADMIN" | "STAFF">("PICK");
  const [isStaffDeviceLocked, setIsStaffDeviceLocked] = useState(false);

  const [adminPin, setAdminPin] = useState("");
  const [staffCode, setStaffCode] = useState("");
  const [staffPin, setStaffPin] = useState("");
  const [errorText, setErrorText] = useState("");

  const [staffList, setStaffList] = useState<EmployeeRecord[]>(FALLBACK_STAFF);
  const [activeStaff, setActiveStaff] = useState<EmployeeRecord | null>(null);

  // Fitur absen inti di Mode Karyawan Terbatas
  const [gpsStatus, setGpsStatus] = useState("Belum diambil");
  const [qrInput, setQrInput] = useState("");
  const [absenMessage, setAbsenMessage] = useState("");

  // Fitur Admin Full Akses
  const [adminTab, setAdminTab] = useState<"MONITORING" | "KARYAWAN" | "PENGATURAN">("MONITORING");
  const [newEmpCode, setNewEmpCode] = useState("");
  const [newEmpName, setNewEmpName] = useState("");
  const [newEmpPin, setNewEmpPin] = useState("");

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    let loadedStaff = FALLBACK_STAFF;
    try {
      const saved = localStorage.getItem(CACHE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.staffList) && parsed.staffList.length > 0) {
          loadedStaff = parsed.staffList;
          setStaffList(parsed.staffList);
        }
      }
    } catch {
      // Pakai fallback
    }

    fetch("/api/absen", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.ok && Array.isArray(data.employees)) {
          const onlyStaff = data.employees.filter(
            (e: EmployeeRecord) => String(e.role || "").toUpperCase() !== "ADMIN"
          );
          if (onlyStaff.length > 0) {
            loadedStaff = onlyStaff;
            setStaffList(onlyStaff);
          }
        }
      })
      .catch(() => {
        // Offline aman
      });

    const locked = localStorage.getItem(STAFF_DEVICE_LOCK_KEY) === "1";
    setIsStaffDeviceLocked(locked);

    if (locked) {
      setLoginScreen("STAFF");
      const staffOk = localStorage.getItem(STAFF_SESSION_KEY) === "1";
      const savedId = Number(localStorage.getItem(STAFF_ID_KEY) || "0");
      const found = loadedStaff.find((s) => s.id === savedId) || null;
      if (staffOk && found) {
        setActiveStaff(found);
        setRoleActive("STAFF");
      } else {
        setRoleActive("NONE");
      }
      return;
    }

    // Jika bukan perangkat karyawan terkunci, cek parameter URL ?mode=admin atau ?mode=karyawan
    const params = new URLSearchParams(window.location.search);
    const modeParam = (params.get("mode") || "").toLowerCase();

    const adminOk = localStorage.getItem(ADMIN_SESSION_KEY) === "1";
    const staffOk = localStorage.getItem(STAFF_SESSION_KEY) === "1";
    const savedId = Number(localStorage.getItem(STAFF_ID_KEY) || "0");
    const foundStaff = loadedStaff.find((s) => s.id === savedId) || null;

    if (adminOk) {
      setRoleActive("ADMIN");
      return;
    }
    if (staffOk && foundStaff) {
      setActiveStaff(foundStaff);
      setRoleActive("STAFF");
      return;
    }

    setRoleActive("NONE");
    if (modeParam === "admin") {
      setLoginScreen("ADMIN");
    } else if (modeParam === "karyawan") {
      setLoginScreen("STAFF");
    } else {
      setLoginScreen("PICK");
    }
  }, []);

  const persistStaffList = (nextList: EmployeeRecord[]) => {
    setStaffList(nextList);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ staffList: nextList }));
    } catch {
      // Abaikan error storage
    }
  };

  const handleAdminLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorText("");

    if (localStorage.getItem(STAFF_DEVICE_LOCK_KEY) === "1") {
      setErrorText("Perangkat ini dikunci khusus Mode Karyawan Terbatas.");
      return;
    }

    const expectedPin = localStorage.getItem("fast_absensi_admin_pin_v6") || DEFAULT_ADMIN_PIN;
    if (adminPin.trim() !== expectedPin.trim()) {
      setErrorText("PIN Admin salah. Akses Mode Full Akses ditolak.");
      return;
    }

    localStorage.removeItem(STAFF_SESSION_KEY);
    localStorage.removeItem(STAFF_ID_KEY);
    localStorage.setItem(ADMIN_SESSION_KEY, "1");
    setAdminPin("");
    setRoleActive("ADMIN");
  };

  const handleStaffLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorText("");

    const codeClean = staffCode.trim().toUpperCase();
    const pinClean = staffPin.trim();

    if (!codeClean || !pinClean) {
      setErrorText("Masukkan ID Karyawan dan PIN Karyawan.");
      return;
    }

    const matched = staffList.find(
      (item) =>
        String(item.role || "STAFF").toUpperCase() === "STAFF" &&
        item.emp_code.trim().toUpperCase() === codeClean &&
        String(item.pin_code || "").trim() === pinClean
    );

    if (!matched) {
      setErrorText("ID Karyawan atau PIN salah.");
      return;
    }

    localStorage.removeItem(ADMIN_SESSION_KEY);
    localStorage.setItem(STAFF_DEVICE_LOCK_KEY, "1");
    localStorage.setItem(STAFF_SESSION_KEY, "1");
    localStorage.setItem(STAFF_ID_KEY, String(matched.id));

    setIsStaffDeviceLocked(true);
    setActiveStaff(matched);
    setStaffCode("");
    setStaffPin("");
    setRoleActive("STAFF");
  };

  const handleLogout = () => {
    localStorage.removeItem(ADMIN_SESSION_KEY);
    localStorage.removeItem(STAFF_SESSION_KEY);
    setActiveStaff(null);
    setErrorText("");
    setRoleActive("NONE");
    setLoginScreen(localStorage.getItem(STAFF_DEVICE_LOCK_KEY) === "1" ? "STAFF" : "PICK");
  };

  const handleAmbilGps = () => {
    if (!navigator.geolocation) {
      setGpsStatus("GPS tidak didukung perangkat.");
      return;
    }
    setGpsStatus("Mengambil koordinat GPS...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsStatus(
          `Lat ${pos.coords.latitude.toFixed(6)}, Lng ${pos.coords.longitude.toFixed(6)}`
        );
      },
      () => {
        setGpsStatus("Gagal mengambil GPS. Izinkan akses lokasi.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleKirimAbsen = (tipe: "MASUK" | "KELUAR") => {
    const waktu = new Date().toLocaleTimeString("id-ID", { hour12: false });
    setAbsenMessage(
      `${tipe} tercatat pukul ${waktu} untuk ${activeStaff?.full_name || "Karyawan"} (QR: ${qrInput.trim() || "MANUAL"}).`
    );
  };

  const handleTambahKaryawan = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmpCode.trim() || !newEmpName.trim() || !newEmpPin.trim()) return;
    const nextItem: EmployeeRecord = {
      id: Date.now(),
      emp_code: newEmpCode.trim().toUpperCase(),
      full_name: newEmpName.trim(),
      role: "STAFF",
      pin_code: newEmpPin.trim(),
    };
    persistStaffList([...staffList, nextItem]);
    setNewEmpCode("");
    setNewEmpName("");
    setNewEmpPin("");
  };

  // GERBANG LOGIN (WAJIB DILALUI SAAT PERTAMA BUKA)
  if (roleActive === "NONE") {
    return (
      <main className="min-h-screen bg-[#0B1220] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl p-5 shadow-2xl space-y-4">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/fast-absensi-pro-mfr.png?v=6"
              alt="Fast Absensi Pro MFR"
              className="w-12 h-12 rounded-xl object-cover border border-amber-400 shrink-0"
            />
            <div>
              <h1 className="text-sm font-black text-slate-900">
                Fast Absensi Pro MFR
              </h1>
              <p className="text-[11px] text-slate-500">
                Login terpisah: Karyawan (Terbatas) &amp; Admin (Full)
              </p>
            </div>
          </div>

          {errorText && (
            <div className="p-2.5 rounded-lg bg-rose-600 text-white text-xs font-bold">
              {errorText}
            </div>
          )}

          {loginScreen === "PICK" && !isStaffDeviceLocked && (
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={() => {
                  setErrorText("");
                  setLoginScreen("STAFF");
                }}
                className="w-full py-3 px-4 rounded-xl bg-sky-700 hover:bg-sky-800 text-white text-xs font-extrabold flex items-center justify-between"
              >
                <span>Aplikasi Karyawan (Mode Terbatas)</span>
                <span>&rarr;</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setErrorText("");
                  setLoginScreen("ADMIN");
                }}
                className="w-full py-3 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-extrabold flex items-center justify-between"
              >
                <span>Aplikasi Admin (Mode Full Akses)</span>
                <span>&rarr;</span>
              </button>
            </div>
          )}

          {loginScreen === "STAFF" && (
            <form onSubmit={handleStaffLogin} className="space-y-3">
              <div className="text-[11px] font-extrabold text-sky-800 bg-sky-50 px-2.5 py-1.5 rounded-lg">
                Login Karyawan • Mode Absen Terbatas
              </div>
              <input
                type="text"
                placeholder="ID Karyawan (contoh: EMP-001)"
                value={staffCode}
                onChange={(e) => setStaffCode(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold uppercase text-slate-900"
              />
              <input
                type="password"
                inputMode="numeric"
                placeholder="PIN Karyawan"
                value={staffPin}
                onChange={(e) => setStaffPin(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-center tracking-widest text-slate-900"
              />
              <button
                type="submit"
                className="w-full py-2.5 rounded-lg bg-sky-700 hover:bg-sky-800 text-white text-xs font-extrabold"
              >
                Masuk Aplikasi Karyawan
              </button>
              {!isStaffDeviceLocked && (
                <button
                  type="button"
                  onClick={() => {
                    setErrorText("");
                    setLoginScreen("PICK");
                  }}
                  className="w-full py-2 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold"
                >
                  Kembali
                </button>
              )}
            </form>
          )}

          {loginScreen === "ADMIN" && !isStaffDeviceLocked && (
            <form onSubmit={handleAdminLogin} className="space-y-3">
              <div className="text-[11px] font-extrabold text-amber-900 bg-amber-50 px-2.5 py-1.5 rounded-lg">
                Login Admin • Mode Full Akses
              </div>
              <input
                type="password"
                inputMode="numeric"
                placeholder="PIN Admin (default: 0000)"
                value={adminPin}
                onChange={(e) => setAdminPin(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-center tracking-widest text-slate-900"
              />
              <button
                type="submit"
                className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-extrabold"
              >
                Masuk Aplikasi Admin
              </button>
              <button
                type="button"
                onClick={() => {
                  setErrorText("");
                  setLoginScreen("PICK");
                }}
                className="w-full py-2 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold"
              >
                Kembali
              </button>
            </form>
          )}
        </div>
      </main>
    );
  }

  // APLIKASI KARYAWAN (MODE TERBATAS — TANPA AKSES ADMIN)
  if (roleActive === "STAFF") {
    return (
      <main className="min-h-screen bg-slate-100 p-4">
        <div className="max-w-md mx-auto space-y-4">
          <header className="bg-[#0B1220] text-white rounded-2xl p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/fast-absensi-pro-mfr.png?v=6"
                alt="Fast Absensi Pro MFR"
                className="w-10 h-10 rounded-xl object-cover border border-amber-400 shrink-0"
              />
              <div>
                <div className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 inline-block">
                  Mode Karyawan • Terbatas
                </div>
                <h1 className="text-sm font-black mt-0.5">
                  {activeStaff?.full_name || "Karyawan"} ({activeStaff?.emp_code})
                </h1>
              </div>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-bold"
            >
              Keluar
            </button>
          </header>

          <section className="bg-white rounded-2xl p-4 shadow space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-extrabold text-slate-800">
                Absensi Masuk &amp; Keluar
              </h2>
              <button
                type="button"
                onClick={handleAmbilGps}
                className="px-2.5 py-1 rounded-lg bg-slate-900 text-white text-[11px] font-bold"
              >
                Ambil GPS
              </button>
            </div>
            <p className="text-[11px] text-slate-600">Status GPS: {gpsStatus}</p>
            <input
              type="text"
              placeholder="Kode QR Lokasi (opsional)"
              value={qrInput}
              onChange={(e) => setQrInput(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
            />
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => handleKirimAbsen("MASUK")}
                className="py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold"
              >
                Absen Masuk
              </button>
              <button
                type="button"
                onClick={() => handleKirimAbsen("KELUAR")}
                className="py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-extrabold"
              >
                Absen Keluar
              </button>
            </div>
            {absenMessage && (
              <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs font-semibold">
                {absenMessage}
              </div>
            )}
          </section>
        </div>
      </main>
    );
  }

  // APLIKASI ADMIN (MODE FULL AKSES)
  return (
    <main className="min-h-screen bg-slate-100 p-4">
      <div className="max-w-3xl mx-auto space-y-4">
        <header className="bg-[#0B1220] text-white rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/fast-absensi-pro-mfr.png?v=6"
              alt="Fast Absensi Pro MFR"
              className="w-10 h-10 rounded-xl object-cover border border-amber-400 shrink-0"
            />
            <div>
              <div className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded bg-amber-400/20 text-amber-300 inline-block">
                Mode Admin • Full Akses
              </div>
              <h1 className="text-sm font-black mt-0.5">
                Fast Absensi Pro MFR — Panel Administrator
              </h1>
            </div>
          </div>

          <button
            type="button"
            onClick={handleLogout}
            className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold"
          >
            Keluar Admin
          </button>
        </header>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAdminTab("MONITORING")}
            className={`px-3 py-2 rounded-xl text-xs font-extrabold ${
              adminTab === "MONITORING"
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-700"
            }`}
          >
            Monitoring
          </button>
          <button
            type="button"
            onClick={() => setAdminTab("KARYAWAN")}
            className={`px-3 py-2 rounded-xl text-xs font-extrabold ${
              adminTab === "KARYAWAN"
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-700"
            }`}
          >
            Data Karyawan ({staffList.length})
          </button>
          <button
            type="button"
            onClick={() => setAdminTab("PENGATURAN")}
            className={`px-3 py-2 rounded-xl text-xs font-extrabold ${
              adminTab === "PENGATURAN"
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-700"
            }`}
          >
            Pengaturan Akses
          </button>
        </div>

        {adminTab === "MONITORING" && (
          <section className="bg-white rounded-2xl p-4 shadow space-y-2">
            <h2 className="text-xs font-extrabold text-slate-800">
              Ringkasan Kehadiran &amp; Kontrol Penuh
            </h2>
            <p className="text-xs text-slate-600">
              Mode Full Akses aktif. Kelola akun karyawan, PIN akses, dan pantau kehadiran tim.
            </p>
          </section>
        )}

        {adminTab === "KARYAWAN" && (
          <section className="bg-white rounded-2xl p-4 shadow space-y-3">
            <h2 className="text-xs font-extrabold text-slate-800">
              Tambah Akun Karyawan (Mode Terbatas)
            </h2>
            <form onSubmit={handleTambahKaryawan} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                placeholder="ID Karyawan (mis. EMP-003)"
                value={newEmpCode}
                onChange={(e) => setNewEmpCode(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs uppercase text-slate-900"
              />
              <input
                type="text"
                placeholder="Nama Karyawan"
                value={newEmpName}
                onChange={(e) => setNewEmpName(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="PIN"
                  value={newEmpPin}
                  onChange={(e) => setNewEmpPin(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
                />
                <button
                  type="submit"
                  className="px-3 py-2 rounded-lg bg-sky-700 text-white text-xs font-bold shrink-0"
                >
                  Simpan
                </button>
              </div>
            </form>

            <div className="divide-y divide-slate-100 text-xs">
              {staffList.map((item) => (
                <div key={item.id} className="py-2 flex items-center justify-between">
                  <div>
                    <span className="font-extrabold text-slate-900">{item.full_name}</span>{" "}
                    <span className="text-slate-500">({item.emp_code})</span>
                  </div>
                  <span className="text-slate-600">PIN: {item.pin_code}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {adminTab === "PENGATURAN" && (
          <section className="bg-white rounded-2xl p-4 shadow space-y-2">
            <h2 className="text-xs font-extrabold text-slate-800">
              Link Instalasi Terpisah
            </h2>
            <p className="text-xs text-slate-600">
              • Link Karyawan (Mode Terbatas): <code>/?mode=karyawan</code>
            </p>
            <p className="text-xs text-slate-600">
              • Link Admin (Mode Full Akses): <code>/?mode=admin</code>
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
