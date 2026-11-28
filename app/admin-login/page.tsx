"use client";

import React, { useState, useEffect, useMemo } from "react";

type RoleType = "ADMIN" | "MANAGER" | "STAFF";
type PrivilegedPortalRole = "ADMIN" | "MANAGER";

interface PrivilegedAccount {
  id: number;
  emp_code: string;
  full_name: string;
  role: PrivilegedPortalRole;
  department: string;
  pin_code: string;
}

const CACHE_KEY = "absensi_v11_cache";
const AUTH_SERVER_KEY = "absensi_v11_auth_server";
const PRIVILEGED_SESSION_KEY = "absensi_v11_privileged_session";
const DEVICE_LOCK_KEY = "absensi_v11_device_locked_karyawan";
const STAFF_SESSION_KEY = "absensi_v11_staff_logged_in";

const DEFAULT_PRIVILEGED_ACCOUNTS: PrivilegedAccount[] = [
  {
    id: 1,
    emp_code: "ADM-001",
    full_name: "Admin Operasional",
    role: "ADMIN",
    department: "Administrator",
    pin_code: "0000",
  },
  {
    id: 2,
    emp_code: "MGR-001",
    full_name: "Manager Operasional",
    role: "MANAGER",
    department: "Manajemen",
    pin_code: "2026",
  },
];

function loadPrivilegedAccountsFromCache(): PrivilegedAccount[] {
  if (typeof window === "undefined") return DEFAULT_PRIVILEGED_ACCOUNTS;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return DEFAULT_PRIVILEGED_ACCOUNTS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.employees)) return DEFAULT_PRIVILEGED_ACCOUNTS;

    const mapped: PrivilegedAccount[] = parsed.employees
      .filter((e: { role?: string }) => {
        const r = String(e.role || "").toUpperCase();
        return r === "ADMIN" || r === "MANAGER";
      })
      .map(
        (
          e: {
            id?: number;
            emp_code?: string;
            full_name?: string;
            role?: RoleType;
            department?: string;
            pin_code?: string;
          },
          idx: number
        ) => {
          const roleUpper: PrivilegedPortalRole =
            String(e.role || "").toUpperCase() === "MANAGER"
              ? "MANAGER"
              : "ADMIN";
          return {
            id: Number(e.id) || idx + 1,
            emp_code: String(
              e.emp_code || (roleUpper === "MANAGER" ? "MGR-001" : "ADM-001")
            ).toUpperCase(),
            full_name: String(
              e.full_name ||
                (roleUpper === "MANAGER"
                  ? "Manager Operasional"
                  : "Admin Operasional")
            ),
            role: roleUpper,
            department: String(
              e.department ||
                (roleUpper === "MANAGER" ? "Manajemen" : "Administrator")
            ),
            pin_code: String(
              e.pin_code || (roleUpper === "MANAGER" ? "2026" : "0000")
            ),
          };
        }
      );

    const hasAdmin = mapped.some((m) => m.role === "ADMIN");
    const hasManager = mapped.some((m) => m.role === "MANAGER");

    const result = [...mapped];
    if (!hasAdmin) result.unshift(DEFAULT_PRIVILEGED_ACCOUNTS[0]);
    if (!hasManager) result.push(DEFAULT_PRIVILEGED_ACCOUNTS[1]);
    return result;
  } catch {
    return DEFAULT_PRIVILEGED_ACCOUNTS;
  }
}

export default function AdminManagerLoginPage() {
  const [selectedRole, setSelectedRole] =
    useState<PrivilegedPortalRole>("ADMIN");
  const [accounts, setAccounts] = useState<PrivilegedAccount[]>(
    DEFAULT_PRIVILEGED_ACCOUNTS
  );
  const [empCodeInput, setEmpCodeInput] = useState("ADM-001");
  const [pinInput, setPinInput] = useState("");
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  useEffect(() => {
    setAccounts(loadPrivilegedAccountsFromCache());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    if (typeof navigator !== "undefined" && navigator.onLine) {
      void fetch("/api/absen", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.ok && Array.isArray(data.employees)) {
            const priv = data.employees
              .filter((e: { role?: string }) => {
                const r = String(e.role || "").toUpperCase();
                return r === "ADMIN" || r === "MANAGER";
              })
              .map(
                (
                  e: {
                    id?: number;
                    emp_code?: string;
                    full_name?: string;
                    role?: RoleType;
                    department?: string;
                    pin_code?: string;
                  },
                  idx: number
                ) => {
                  const roleUpper: PrivilegedPortalRole =
                    String(e.role || "").toUpperCase() === "MANAGER"
                      ? "MANAGER"
                      : "ADMIN";
                  return {
                    id: Number(e.id) || idx + 1,
                    emp_code: String(e.emp_code || "").toUpperCase(),
                    full_name: String(e.full_name || ""),
                    role: roleUpper,
                    department: String(e.department || ""),
                    pin_code: String(
                      e.pin_code || (roleUpper === "MANAGER" ? "2026" : "0000")
                    ),
                  };
                }
              );
            if (priv.length > 0) {
              setAccounts((prev) => {
                const merged = [...priv];
                if (!merged.some((m) => m.role === "ADMIN")) {
                  merged.unshift(
                    prev.find((p) => p.role === "ADMIN") ||
                      DEFAULT_PRIVILEGED_ACCOUNTS[0]
                  );
                }
                if (!merged.some((m) => m.role === "MANAGER")) {
                  merged.push(
                    prev.find((p) => p.role === "MANAGER") ||
                      DEFAULT_PRIVILEGED_ACCOUNTS[1]
                  );
                }
                return merged;
              });
            }
          }
        })
        .catch(() => {
          // Gunakan data cache lokal
        });
    }

    return () => clearInterval(timer);
  }, []);

  const activeRoleAccount = useMemo(() => {
    return (
      accounts.find((a) => a.role === selectedRole) ||
      (selectedRole === "MANAGER"
        ? DEFAULT_PRIVILEGED_ACCOUNTS[1]
        : DEFAULT_PRIVILEGED_ACCOUNTS[0])
    );
  }, [accounts, selectedRole]);

  const handleSwitchRole = (role: PrivilegedPortalRole) => {
    setSelectedRole(role);
    const target = accounts.find((a) => a.role === role);
    setEmpCodeInput(
      target?.emp_code || (role === "MANAGER" ? "MGR-001" : "ADM-001")
    );
    setPinInput("");
    setErrorMsg("");
    setIsSubmitting(false);
  };

  const wibClockText = useMemo(
    () =>
      new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        weekday: "long",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(nowMs)) + " WIB",
    [nowMs]
  );

  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setIsSubmitting(true);

    const codeClean = empCodeInput.trim().toUpperCase();
    const pinClean = pinInput.trim();

    if (!pinClean) {
      setErrorMsg(`Masukkan PIN ${selectedRole}.`);
      setIsSubmitting(false);
      return;
    }

    const matched = accounts.find(
      (acc) =>
        acc.role === selectedRole &&
        (!codeClean || acc.emp_code.toUpperCase() === codeClean) &&
        String(acc.pin_code || "").trim() === pinClean
    );

    if (!matched) {
      setErrorMsg(
        `Kode atau PIN ${selectedRole} tidak sesuai. Default ${selectedRole}: ${
          selectedRole === "MANAGER" ? "2026" : "0000"
        }.`
      );
      setIsSubmitting(false);
      return;
    }

    try {
      // Hapus kunci mode karyawan di browser ini agar tidak memblokir masuk Admin/Manager
      localStorage.removeItem(DEVICE_LOCK_KEY);
      localStorage.removeItem(STAFF_SESSION_KEY);
      localStorage.setItem(AUTH_SERVER_KEY, selectedRole);
      localStorage.setItem(
        PRIVILEGED_SESSION_KEY,
        JSON.stringify({
          id: matched.id,
          emp_code: matched.emp_code,
          full_name: matched.full_name,
          role: matched.role,
          department: matched.department,
          logged_in_at: new Date(nowMs).toISOString(),
        })
      );
    } catch {
      // Abaikan error storage
    }

    const destination =
      selectedRole === "MANAGER" ? "/?server=manager" : "/?server=admin";
    window.location.replace(destination);
  };

  return (
    <div className="min-h-screen bg-[#ECEFF4] text-slate-900 flex items-center justify-center p-3.5 sm:p-5">
      <div className="max-w-md w-full space-y-3.5">
        <header className="bg-[#0B1220] text-white rounded-2xl p-4 shadow space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h1 className="text-sm font-extrabold tracking-wide uppercase">
                PORTAL LOGIN ADMIN &amp; MANAGER
              </h1>
              <p className="text-[11px] text-slate-300 mt-0.5">
                Akses Terpisah dari Login Karyawan • Absensi QR &amp; GPS
              </p>
            </div>
            <span
              className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase shrink-0 ${
                selectedRole === "MANAGER"
                  ? "bg-amber-500 text-slate-950"
                  : "bg-indigo-500 text-white"
              }`}
            >
              {selectedRole === "MANAGER"
                ? "PORTAL MANAGER"
                : "PORTAL ADMIN"}
            </span>
          </div>

          <div className="text-[11px] font-mono text-emerald-300 bg-white/5 px-2.5 py-1.5 rounded-lg">
            {wibClockText}
          </div>
        </header>

        <section className="bg-white rounded-2xl p-4 border-t-4 border-t-blue-600 border border-slate-200/80 shadow-sm space-y-3.5">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleSwitchRole("ADMIN")}
              className={`py-2 rounded-lg text-xs font-extrabold border transition ${
                selectedRole === "ADMIN"
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-slate-50 text-slate-700 border-slate-300"
              }`}
            >
              Login Admin
            </button>
            <button
              type="button"
              onClick={() => handleSwitchRole("MANAGER")}
              className={`py-2 rounded-lg text-xs font-extrabold border transition ${
                selectedRole === "MANAGER"
                  ? "bg-amber-500 text-slate-950 border-amber-500"
                  : "bg-slate-50 text-slate-700 border-slate-300"
              }`}
            >
              Login Manager
            </button>
          </div>

          <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-600 space-y-0.5">
            <div className="font-bold text-slate-800">
              Akun Terpilih: {activeRoleAccount.full_name} (
              {activeRoleAccount.emp_code})
            </div>
            <div className="text-[10px] text-slate-500">
              Departemen: {activeRoleAccount.department || selectedRole} • PIN
              Default: {selectedRole === "MANAGER" ? "2026" : "0000"}
            </div>
          </div>

          {errorMsg && (
            <div className="px-3 py-2 rounded-lg bg-rose-600 text-white text-xs font-bold">
              {errorMsg}
            </div>
          )}

          <form onSubmit={handleLoginSubmit} className="space-y-2.5">
            <div>
              <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">
                Kode {selectedRole}
              </label>
              <input
                type="text"
                value={empCodeInput}
                onChange={(e) => setEmpCodeInput(e.target.value)}
                placeholder={
                  selectedRole === "MANAGER" ? "MGR-001" : "ADM-001"
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold uppercase"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">
                PIN {selectedRole}
              </label>
              <input
                type="password"
                inputMode="numeric"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder={
                  selectedRole === "MANAGER"
                    ? "Masukkan PIN Manager (default: 2026)"
                    : "Masukkan PIN Admin (default: 0000)"
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-center tracking-widest"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-extrabold"
            >
              {isSubmitting
                ? "Membuka Dasbor..."
                : `Masuk Dasbor ${selectedRole}`}
            </button>
          </form>

          <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
            <a
              href="/?server=karyawan"
              className="font-bold text-sky-700 hover:underline"
            >
              Buka Login Karyawan
            </a>
            <a
              href="/?server=admin"
              className="font-bold text-slate-600 hover:underline"
            >
              Kembali ke Utama
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
