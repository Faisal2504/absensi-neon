"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

type RoleType = "ADMIN" | "MANAGER" | "STAFF";
type ServerMode = "ADMIN" | "MANAGER" | "KARYAWAN";

interface Employee {
  id: number;
  emp_code: string;
  full_name: string;
  role: RoleType;
  department: string;
  pin_code: string;
  shift_start_time?: string;
}

interface LocationItem {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
}

interface TimeEntry {
  id?: number;
  client_uuid: string;
  employee_id: number;
  entry_type: "CLOCK_IN" | "CLOCK_OUT";
  punched_at: string;
  is_offline_sync?: boolean;
  qr_code?: string;
  mode?: string;
  notes?: string;
  latitude?: number | null;
  longitude?: number | null;
  distance_meters?: number | null;
  is_within_geofence?: boolean;
  selfie_data?: string | null;
  face_detected?: boolean;
  full_name?: string;
  emp_code?: string;
}

interface FaceDetectorInstance {
  detect: (
    image: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement
  ) => Promise<Array<{ boundingBox: DOMRectReadOnly }>>;
}

interface BarcodeDetectorInstance {
  detect: (
    video: HTMLVideoElement
  ) => Promise<Array<{ rawValue?: string; raw_value?: string }>>;
}

const DEFAULT_LAT = -6.9148609;
const DEFAULT_LNG = 109.744683;
const DEFAULT_RADIUS = 2000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const SHIFT_OPTIONS = [
  { label: "Shift Pagi (07.00)", time: "07.00" },
  { label: "Shift Siang (15.00)", time: "15.00" },
  { label: "Shift Malam (23.00)", time: "23.00" },
];

const CACHE_KEY = "absensi_v11_cache";
const QUEUE_KEY = "absensi_v11_queue";
const QR_CODE_KEY = "absensi_v11_qr";
const LOC_KEY = "absensi_v11_custom_loc";
const DEVICE_LOCK_KEY = "absensi_v11_device_locked_karyawan";
const STAFF_EMP_KEY = "absensi_v11_staff_emp_id";
const AUTH_SERVER_KEY = "absensi_v11_auth_server";

function normalizeShiftTime(raw?: string | null): string {
  const s = String(raw || "").trim();
  if (!s) return "07.00";
  if (s.includes("15:00") || s.includes("15.00") || s.toLowerCase().includes("siang")) {
    return "15.00";
  }
  if (s.includes("23:00") || s.includes("23.00") || s.toLowerCase().includes("malam")) {
    return "23.00";
  }
  if (s.includes("07:00") || s.includes("07.00") || s.toLowerCase().includes("pagi")) {
    return "07.00";
  }
  return s.replace(":", ".");
}

function normalizeRole(raw?: string | null): RoleType {
  const r = String(raw || "STAFF").toUpperCase();
  if (r === "ADMIN") return "ADMIN";
  if (r === "MANAGER") return "MANAGER";
  return "STAFF";
}

function normalizeEntryType(raw?: string | null): "CLOCK_IN" | "CLOCK_OUT" {
  const t = String(raw || "CLOCK_IN").toUpperCase();
  return t === "CLOCK_OUT" || t === "OUT" ? "CLOCK_OUT" : "CLOCK_IN";
}

const DEFAULT_EMPLOYEES: Employee[] = [
  {
    id: 1,
    emp_code: "ADM-001",
    full_name: "Admin Operasional",
    role: "ADMIN",
    department: "Administrator",
    pin_code: "0000",
    shift_start_time: "07.00",
  },
  {
    id: 2,
    emp_code: "MGR-001",
    full_name: "Manager Operasional",
    role: "MANAGER",
    department: "Manajemen",
    pin_code: "2026",
    shift_start_time: "07.00",
  },
  {
    id: 3,
    emp_code: "ABZ-0001",
    full_name: "Amelia",
    role: "STAFF",
    department: "Operasional",
    pin_code: "1111",
    shift_start_time: "07.00",
  },
];

const DEFAULT_LOCATIONS: LocationItem[] = [
  {
    id: 1,
    name: "Kantor Utama",
    latitude: DEFAULT_LAT,
    longitude: DEFAULT_LNG,
    radius_meters: DEFAULT_RADIUS,
  },
];

const getJakartaDateStr = (iso?: string) =>
  new Date(iso || new Date().toISOString()).toLocaleDateString("en-CA", {
    timeZone: "Asia/Jakarta",
  });

const formatTimeWIB = (iso?: string | null) =>
  !iso
    ? "-"
    : new Date(iso).toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

const formatDateTimeLocalWIB = (iso?: string | null) => {
  if (!iso) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(" ", "T");
};

function calcLateMinutes(punchedIso: string, shiftStart = "07.00") {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(punchedIso))
    .split(":");
  const actualMin = Number(parts[0]) * 60 + Number(parts[1]);
  const [sh, sm] = normalizeShiftTime(shiftStart)
    .replace(".", ":")
    .split(":")
    .map(Number);
  const startMin = (isNaN(sh) ? 7 : sh) * 60 + (isNaN(sm) ? 0 : sm);
  return Math.max(0, actualMin - startMin);
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function extractLinesFromPdfBytes(bytes: Uint8Array): string[] {
  const raw = new TextDecoder("latin1").decode(bytes);
  const lines: string[] = [];
  const matches = raw.match(/\(([^()\\]{2,160})\)/g) || [];
  for (const m of matches) {
    const cleaned = m
      .slice(1, -1)
      .replace(/\\([()\\])/g, "$1")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 2 && /[a-zA-Z0-9]/.test(cleaned)) {
      lines.push(cleaned);
    }
  }
  return lines;
}

function parseScheduleLines(
  lines: string[]
): Array<{ emp_code: string; full_name: string; shift_time: string }> {
  const parsed: Array<{
    emp_code: string;
    full_name: string;
    shift_time: string;
  }> = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (
      lower.includes("emp_code") ||
      (lower.includes("jadwal") && lower.length < 20) ||
      (lower.includes("nama") && lower.includes("shift") && lower.length < 32)
    ) {
      continue;
    }

    const timeMatch = line.match(
      /\b(07[:.]00|15[:.]00|23[:.]00|[012]?\d[:.]\d{2})\b/
    );
    let shiftTime = "07.00";
    if (timeMatch) {
      shiftTime = normalizeShiftTime(timeMatch[1]);
    } else if (lower.includes("siang")) {
      shiftTime = "15.00";
    } else if (lower.includes("malam")) {
      shiftTime = "23.00";
    } else if (lower.includes("pagi")) {
      shiftTime = "07.00";
    }

    const codeMatch = line.match(/\b([A-Z]{2,5}[-_]\d{1,5})\b/i);
    let cols = line
      .split(/[,;|]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (cols.length === 1 && /\s{2,}|\s+[-–—]\s+/.test(line)) {
      cols = line
        .split(/\s{2,}|\s+[-–—]\s+/)
        .map((c) => c.trim())
        .filter(Boolean);
    }

    const empCode = codeMatch ? codeMatch[1].toUpperCase() : "";
    let fullName = "";

    if (cols.length >= 2) {
      if (!empCode && /^[A-Z0-9_-]{2,12}$/i.test(cols[0])) {
        fullName = cols[1];
      } else {
        fullName = cols[0];
      }
    } else {
      fullName = line
        .replace(/\b([A-Z]{2,5}[-_]\d{1,5})\b/gi, " ")
        .replace(/shift\s*(pagi|siang|malam)/gi, " ")
        .replace(/\b([012]?\d[:.]\d{2})\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    fullName = fullName
      .replace(/shift\s*(pagi|siang|malam)/gi, " ")
      .replace(/\b([012]?\d[:.]\d{2})\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (fullName || empCode) {
      parsed.push({
        emp_code:
          empCode || `KRY-${String(parsed.length + 1).padStart(3, "0")}`,
        full_name: fullName || empCode,
        shift_time: shiftTime,
      });
    }
  }

  return parsed;
}

function parseSavedLocation(raw: string | null): LocationItem | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    const rad = Math.max(10, Number(p.radius_meters) || DEFAULT_RADIUS);
    if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return {
        id: Number(p.id) || 1,
        name: String(p.name || "Kantor Utama"),
        latitude: lat,
        longitude: lng,
        radius_meters: rad,
      };
    }
  } catch {
    // Abaikan
  }
  return null;
}

function getInitialBoot() {
  if (typeof window === "undefined") {
    return {
      serverMode: "ADMIN" as ServerMode,
      isDeviceLockedKaryawan: false,
      isAuthenticatedPrivileged: true,
      qrCode: "ABSENSI-KANTOR-MPI-BTG",
      staffEmpId: 3,
      queue: [] as TimeEntry[],
      employees: DEFAULT_EMPLOYEES,
      locations: DEFAULT_LOCATIONS,
      entries: [] as TimeEntry[],
    };
  }

  let qrCode = "ABSENSI-KANTOR-MPI-BTG";
  let staffEmpId = 3;
  let queue: TimeEntry[] = [];
  let employees = DEFAULT_EMPLOYEES;
  let locations = DEFAULT_LOCATIONS;
  let entries: TimeEntry[] = [];
  let isDeviceLockedKaryawan = false;
  let serverMode: ServerMode = "ADMIN";
  let isAuthenticatedPrivileged = true;

  try {
    const params = new URLSearchParams(window.location.search);
    const qServer = (params.get("server") || "").toLowerCase();

    if (
      qServer === "karyawan" ||
      qServer === "staff" ||
      localStorage.getItem(DEVICE_LOCK_KEY) === "1"
    ) {
      localStorage.setItem(DEVICE_LOCK_KEY, "1");
      localStorage.removeItem(AUTH_SERVER_KEY);
      isDeviceLockedKaryawan = true;
      serverMode = "KARYAWAN";
      isAuthenticatedPrivileged = false;
    } else if (qServer === "manager") {
      serverMode = "MANAGER";
      isAuthenticatedPrivileged =
        localStorage.getItem(AUTH_SERVER_KEY) === "MANAGER";
    } else {
      serverMode = "ADMIN";
      isAuthenticatedPrivileged = true;
    }

    const savedQr = localStorage.getItem(QR_CODE_KEY);
    if (savedQr) qrCode = savedQr;

    const savedStaff = localStorage.getItem(STAFF_EMP_KEY);
    if (savedStaff && Number(savedStaff) > 0) staffEmpId = Number(savedStaff);

    const rawQ = localStorage.getItem(QUEUE_KEY);
    if (rawQ) {
      const parsedQ = JSON.parse(rawQ);
      if (Array.isArray(parsedQ)) queue = parsedQ;
    }

    const rawC = localStorage.getItem(CACHE_KEY);
    if (rawC) {
      const c = JSON.parse(rawC);
      if (Array.isArray(c.employees) && c.employees.length > 0) {
        employees = c.employees.map((e: Employee) => ({
          ...e,
          role: normalizeRole(e.role),
          shift_start_time: normalizeShiftTime(e.shift_start_time),
        }));
      }
      if (Array.isArray(c.locations) && c.locations.length > 0) {
        locations = c.locations.map((l: LocationItem) => ({
          id: Number(l.id) || 1,
          name: String(l.name || "Kantor Utama"),
          latitude: Number(l.latitude) || DEFAULT_LAT,
          longitude: Number(l.longitude) || DEFAULT_LNG,
          radius_meters: Math.max(10, Number(l.radius_meters) || DEFAULT_RADIUS),
        }));
      }
      if (Array.isArray(c.entries)) {
        entries = c.entries.map((item: TimeEntry) => ({
          ...item,
          entry_type: normalizeEntryType(item.entry_type),
          client_uuid:
            item.client_uuid ||
            `srv-${item.id || Math.random().toString(36).slice(2)}`,
        }));
      }
    }

    const customLoc = parseSavedLocation(localStorage.getItem(LOC_KEY));
    if (customLoc) {
      locations = [customLoc];
    }
  } catch {
    // Abaikan error storage
  }

  return {
    serverMode,
    isDeviceLockedKaryawan,
    isAuthenticatedPrivileged,
    qrCode,
    staffEmpId,
    queue,
    employees,
    locations,
    entries,
  };
}

export default function AbsensiMultiServerPage() {
  const boot = useMemo(() => getInitialBoot(), []);

  const [serverMode, setServerMode] = useState<ServerMode>(boot.serverMode);
  const [isDeviceLockedKaryawan, setIsDeviceLockedKaryawan] = useState<boolean>(
    boot.isDeviceLockedKaryawan
  );
  const [isPrivilegedAuthed, setIsPrivilegedAuthed] = useState<boolean>(
    boot.isAuthenticatedPrivileged
  );
  const [pinEntry, setPinEntry] = useState("");

  const [employees, setEmployees] = useState<Employee[]>(boot.employees);
  const [locations, setLocations] = useState<LocationItem[]>(boot.locations);
  const [serverEntries, setServerEntries] = useState<TimeEntry[]>(boot.entries);
  const [offlineQueue, setOfflineQueue] = useState<TimeEntry[]>(boot.queue);
  const [staffEmpId, setStaffEmpId] = useState<number>(boot.staffEmpId);
  const [dbConnected, setDbConnected] = useState<boolean>(true);

  const [serverOffsetMs, setServerOffsetMs] = useState<number>(0);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [isSyncing, setIsSyncing] = useState(false);

  const [selectedAction, setSelectedAction] = useState<"CLOCK_IN" | "CLOCK_OUT">(
    "CLOCK_IN"
  );
  const [officeQrCode, setOfficeQrCode] = useState<string>(boot.qrCode);
  const [qrInput, setQrInput] = useState("");
  const [qrCameraOn, setQrCameraOn] = useState(false);
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(
    null
  );
  const [gpsStatusText, setGpsStatusText] = useState<string>(
    "Menunggu pembacaan GPS perangkat..."
  );

  const [selfieCameraOn, setSelfieCameraOn] = useState(false);
  const [capturedSelfie, setCapturedSelfie] = useState<string | null>(null);
  const [faceStatus, setFaceStatus] = useState<
    "idle" | "scanning" | "detected" | "no_face" | "fallback"
  >("idle");
  const [faceText, setFaceText] = useState(
    "Arahkan wajah ke kamera depan lalu klik Ambil Foto Selfie."
  );

  const [scheduleFileName, setScheduleFileName] = useState(
    "Tidak ada file yang dipilih"
  );
  const [schedulePreview, setSchedulePreview] = useState<
    Array<{ emp_code: string; full_name: string; shift_time: string }>
  >([]);

  const [reportFilter, setReportFilter] = useState<
    "Harian" | "Mingguan" | "Bulanan"
  >("Harian");
  const [editingUuid, setEditingUuid] = useState<string | null>(null);
  const [editId, setEditId] = useState<number | undefined>(undefined);
  const [editType, setEditType] = useState<"CLOCK_IN" | "CLOCK_OUT">(
    "CLOCK_IN"
  );
  const [editTimeLocal, setEditTimeLocal] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const [empForm, setEmpForm] = useState({
    id: 0,
    emp_code: "",
    full_name: "",
    role: "STAFF" as RoleType,
    department: "Operasional",
    pin_code: "1234",
    shift_start_time: "07.00",
  });
  const [latInput, setLatInput] = useState<string>(
    String(boot.locations[0]?.latitude ?? DEFAULT_LAT)
  );
  const [lngInput, setLngInput] = useState<string>(
    String(boot.locations[0]?.longitude ?? DEFAULT_LNG)
  );
  const [radiusInput, setRadiusInput] = useState<string>(
    String(boot.locations[0]?.radius_meters ?? DEFAULT_RADIUS)
  );

  const [toast, setToast] = useState<{
    type: "ok" | "warn" | "err";
    text: string;
  } | null>(null);

  const qrVideoRef = useRef<HTMLVideoElement | null>(null);
  const qrRafRef = useRef<number | null>(null);
  const selfieVideoRef = useRef<HTMLVideoElement | null>(null);
  const selfieCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const faceRafRef = useRef<number | null>(null);
  const scheduleInputRef = useRef<HTMLInputElement | null>(null);
  const offsetRef = useRef<number>(0);

  const notify = useCallback((type: "ok" | "warn" | "err", text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 4500);
  }, []);

  useEffect(() => {
    offsetRef.current = serverOffsetMs;
  }, [serverOffsetMs]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now() + offsetRef.current);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const syncedIsoNow = useMemo(() => new Date(nowMs).toISOString(), [nowMs]);

  const indonesiaClockWIB = useMemo(
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

  const staffList = useMemo(
    () => employees.filter((e) => e.role === "STAFF"),
    [employees]
  );

  const activeUser = useMemo(() => {
    if (isDeviceLockedKaryawan || serverMode === "KARYAWAN") {
      return (
        staffList.find((e) => Number(e.id) === Number(staffEmpId)) ||
        staffList[0] ||
        DEFAULT_EMPLOYEES[2]
      );
    }
    if (serverMode === "MANAGER") {
      return (
        employees.find((e) => e.role === "MANAGER") || DEFAULT_EMPLOYEES[1]
      );
    }
    return employees.find((e) => e.role === "ADMIN") || DEFAULT_EMPLOYEES[0];
  }, [isDeviceLockedKaryawan, serverMode, staffList, staffEmpId, employees]);

  const isKaryawanMode = isDeviceLockedKaryawan || serverMode === "KARYAWAN";
  const isManagerServer = !isKaryawanMode && serverMode === "MANAGER";
  const isAdminServer = !isKaryawanMode && serverMode === "ADMIN";

  const stopQrCam = useCallback(() => {
    if (qrRafRef.current !== null) {
      cancelAnimationFrame(qrRafRef.current);
      qrRafRef.current = null;
    }
    if (qrVideoRef.current?.srcObject) {
      (qrVideoRef.current.srcObject as MediaStream)
        .getTracks()
        .forEach((t) => t.stop());
      qrVideoRef.current.srcObject = null;
    }
    setQrCameraOn(false);
  }, []);

  const stopSelfieCam = useCallback(() => {
    if (faceRafRef.current !== null) {
      cancelAnimationFrame(faceRafRef.current);
      faceRafRef.current = null;
    }
    if (selfieVideoRef.current?.srcObject) {
      (selfieVideoRef.current.srcObject as MediaStream)
        .getTracks()
        .forEach((t) => t.stop());
      selfieVideoRef.current.srcObject = null;
    }
    setSelfieCameraOn(false);
  }, []);

  const syncOfflineQueue = useCallback(
    async (queue: TimeEntry[], silent = false) => {
      if (!navigator.onLine || queue.length === 0) return;
      setIsSyncing(true);
      try {
        const res = await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "SUBMIT_PUNCH", punches: queue }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.ok) {
          localStorage.removeItem(QUEUE_KEY);
          setOfflineQueue([]);
          if (Array.isArray(data.entries)) {
            setServerEntries(data.entries);
          }
          if (!silent) {
            notify("ok", `${data.syncedCount || queue.length} data tersinkron.`);
          }
        }
      } catch {
        // Tetap di antrean lokal
      } finally {
        setIsSyncing(false);
      }
    },
    [notify]
  );

  const refreshServer = useCallback(
    async (silent = false) => {
      if (!navigator.onLine) {
        setNowMs(Date.now() + offsetRef.current);
        if (!silent) notify("warn", "Offline: jam WIB tersinkronisasi lokal.");
        return;
      }
      setIsSyncing(true);
      try {
        const rawQ = localStorage.getItem(QUEUE_KEY);
        const pending: TimeEntry[] = rawQ ? JSON.parse(rawQ) : [];
        if (pending.length > 0) await syncOfflineQueue(pending, true);

        const res = await fetch("/api/absen", { cache: "no-store" });
        const headerDate = res.headers.get("date");
        let nextOffset = offsetRef.current;
        if (headerDate) {
          const srvMs = new Date(headerDate).getTime();
          if (!isNaN(srvMs)) {
            nextOffset = srvMs - Date.now();
            setServerOffsetMs(nextOffset);
          }
        }
        setNowMs(Date.now() + nextOffset);

        if (res.ok) {
          const data = await res.json();
          if (data?.ok) {
            setDbConnected(Boolean(data.dbConnected));
            setEmployees((prevEmps) => {
              const nextEmps: Employee[] =
                Array.isArray(data.employees) && data.employees.length > 0
                  ? data.employees.map((e: Employee) => ({
                      ...e,
                      role: normalizeRole(e.role),
                      shift_start_time: normalizeShiftTime(e.shift_start_time),
                    }))
                  : prevEmps;

              const customLoc = parseSavedLocation(localStorage.getItem(LOC_KEY));
              let nextLocs: LocationItem[] =
                Array.isArray(data.locations) && data.locations.length > 0
                  ? data.locations.map((l: LocationItem) => ({
                      id: Number(l.id) || 1,
                      name: String(l.name || "Kantor Utama"),
                      latitude: Number(l.latitude) || DEFAULT_LAT,
                      longitude: Number(l.longitude) || DEFAULT_LNG,
                      radius_meters: Math.max(
                        10,
                        Number(l.radius_meters) || DEFAULT_RADIUS
                      ),
                    }))
                  : DEFAULT_LOCATIONS;

              if (customLoc) {
                nextLocs = [customLoc];
              }

              setLocations(nextLocs);
              setLatInput(String(nextLocs[0]?.latitude ?? DEFAULT_LAT));
              setLngInput(String(nextLocs[0]?.longitude ?? DEFAULT_LNG));
              setRadiusInput(String(nextLocs[0]?.radius_meters ?? DEFAULT_RADIUS));

              setServerEntries((prevEntries) => {
                const nextEntries: TimeEntry[] = Array.isArray(data.entries)
                  ? data.entries.map((item: TimeEntry) => ({
                      ...item,
                      entry_type: normalizeEntryType(item.entry_type),
                      client_uuid:
                        item.client_uuid ||
                        `srv-${item.id || Math.random().toString(36).slice(2)}`,
                    }))
                  : prevEntries;

                localStorage.setItem(
                  CACHE_KEY,
                  JSON.stringify({
                    employees: nextEmps,
                    locations: nextLocs,
                    entries: nextEntries,
                  })
                );
                return nextEntries;
              });

              return nextEmps;
            });

            if (!silent) {
              notify(
                data.dbConnected ? "ok" : "warn",
                data.dbConnected
                  ? "Terhubung ke Database Neon & Jam WIB sinkron."
                  : `Peringatan DB: ${data.dbError || "DATABASE_URL belum aktif"}`
              );
            }
          }
        }
      } catch {
        setNowMs(Date.now() + offsetRef.current);
        if (!silent) {
          notify("warn", "Mode lokal/cache aktif; jam WIB tetap berjalan.");
        }
      } finally {
        setIsSyncing(false);
      }
    },
    [notify, syncOfflineQueue]
  );

  // Polling realtime setiap 3 detik agar data absen karyawan langsung muncul di Admin & Manager
  useEffect(() => {
    if (!isOnline || isKaryawanMode) return;
    const poller = window.setInterval(() => {
      void refreshServer(true);
    }, 3000);
    return () => clearInterval(poller);
  }, [isOnline, isKaryawanMode, refreshServer]);

  const requestCurrentGps = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setGpsStatusText("GPS browser tidak tersedia.");
      return;
    }
    setGpsStatusText("Mengambil posisi GPS...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(7));
        const lng = Number(pos.coords.longitude.toFixed(7));
        setGpsCoords({ lat, lng });
        setGpsStatusText(`GPS aktif: ${lat}, ${lng}`);
      },
      (err) => {
        setGpsStatusText(
          err.code === 1
            ? "Izin lokasi ditolak. Aktifkan izin GPS di browser."
            : "Sinyal GPS lemah. Coba ambil ulang GPS."
        );
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 }
    );
  }, []);

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      void refreshServer(true);
    };
    const onOffline = () => {
      setIsOnline(false);
      notify("warn", "Offline: absensi masuk antrean lokal.");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const t = window.setTimeout(() => {
      void refreshServer(true);
      requestCurrentGps();
    }, 0);

    return () => {
      clearTimeout(t);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      stopQrCam();
      stopSelfieCam();
    };
  }, [refreshServer, requestCurrentGps, notify, stopQrCam, stopSelfieCam]);

  const targetLocation = useMemo(() => {
    const loc = locations[0] || DEFAULT_LOCATIONS[0];
    return {
      latitude: Number(loc.latitude),
      longitude: Number(loc.longitude),
      radius_meters: Math.max(10, Number(loc.radius_meters) || DEFAULT_RADIUS),
    };
  }, [locations]);

  const geofence = useMemo(() => {
    if (!gpsCoords) return null;
    const dist = haversineMeters(
      gpsCoords.lat,
      gpsCoords.lng,
      targetLocation.latitude,
      targetLocation.longitude
    );
    return {
      distance: dist,
      inside: dist <= targetLocation.radius_meters,
    };
  }, [gpsCoords, targetLocation]);

  const geofenceLabel = useMemo(() => {
    if (!geofence) {
      return `${gpsStatusText} • Target (${targetLocation.latitude}, ${targetLocation.longitude}) • Radius ${targetLocation.radius_meters}m`;
    }
    return `GPS: Jarak ${geofence.distance}m / ${targetLocation.radius_meters}m (${
      geofence.inside ? "Aman • Di Dalam Radius" : "Di Luar Radius Kantor"
    })`;
  }, [geofence, gpsStatusText, targetLocation]);

  const allEntries = useMemo(() => {
    const seen = new Set(serverEntries.map((e) => e.client_uuid));
    const pending = offlineQueue.filter((q) => !seen.has(q.client_uuid));
    return [...pending, ...serverEntries].sort(
      (a, b) =>
        new Date(b.punched_at).getTime() - new Date(a.punched_at).getTime()
    );
  }, [serverEntries, offlineQueue]);

  const cooldownInfo = useMemo(() => {
    if (!activeUser) {
      return {
        locked: false,
        remainingText: "",
        lastEntry: null as TimeEntry | null,
      };
    }
    const mine = allEntries
      .filter((e) => Number(e.employee_id) === Number(activeUser.id))
      .sort(
        (a, b) =>
          new Date(b.punched_at).getTime() - new Date(a.punched_at).getTime()
      );
    const last = mine[0] || null;
    if (!last) {
      return { locked: false, remainingText: "", lastEntry: null };
    }
    const diff = nowMs - new Date(last.punched_at).getTime();
    if (diff >= 0 && diff < SIX_HOURS_MS) {
      const remMins = Math.ceil((SIX_HOURS_MS - diff) / 60000);
      const h = Math.floor(remMins / 60);
      const m = remMins % 60;
      return {
        locked: true,
        remainingText: h > 0 ? `${h} jam ${m} menit` : `${m} menit`,
        lastEntry: last,
      };
    }
    return { locked: false, remainingText: "", lastEntry: last };
  }, [activeUser, allEntries, nowMs]);

  const startScannerCamera = async () => {
    try {
      stopSelfieCam();
      setQrCameraOn(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (qrVideoRef.current) {
        qrVideoRef.current.srcObject = stream;
        await qrVideoRef.current.play();
      }
      const BD = (
        window as unknown as {
          BarcodeDetector?: new (opts: {
            formats: string[];
          }) => BarcodeDetectorInstance;
        }
      ).BarcodeDetector;

      if (BD) {
        const detector = new BD({
          formats: ["qr_code", "code_128", "code_39", "ean_13"],
        });
        const step = async () => {
          if (!qrVideoRef.current || !qrVideoRef.current.srcObject) return;
          try {
            const codes = await detector.detect(qrVideoRef.current);
            const raw = (codes[0]?.rawValue || codes[0]?.raw_value || "")
              .trim()
              .toUpperCase();
            if (raw) {
              setQrInput(raw);
              stopQrCam();
              notify("ok", `Barcode/QR terbaca: ${raw}`);
              return;
            }
          } catch {
            // Lanjutkan scan
          }
          qrRafRef.current = requestAnimationFrame(step);
        };
        qrRafRef.current = requestAnimationFrame(step);
      } else {
        notify(
          "warn",
          "Kamera scanner aktif. Ketik kode manual jika tidak terbaca otomatis."
        );
      }
    } catch {
      setQrCameraOn(false);
      notify("warn", "Kamera terkendala. Masukkan kode barcode/QR manual.");
    }
  };

  const runFaceLoop = useCallback(() => {
    const FD = (
      window as unknown as {
        FaceDetector?: new (opts?: {
          fastMode?: boolean;
          maxDetectedFaces?: number;
        }) => FaceDetectorInstance;
      }
    ).FaceDetector;

    if (!FD) {
      setFaceStatus("fallback");
      setFaceText(
        "Deteksi wajah otomatis tidak tersedia di browser ini; klik Ambil Foto Selfie."
      );
      return;
    }

    const detector = new FD({ fastMode: true, maxDetectedFaces: 1 });
    setFaceStatus("scanning");
    setFaceText("Mendeteksi wajah...");

    const loop = async () => {
      if (!selfieVideoRef.current || !selfieVideoRef.current.srcObject) return;
      try {
        const faces = await detector.detect(selfieVideoRef.current);
        if (faces.length > 0) {
          setFaceStatus("detected");
          setFaceText("Wajah terdeteksi! Klik Ambil Foto Selfie.");
        } else {
          setFaceStatus("no_face");
          setFaceText("Wajah belum terlihat di kamera depan.");
        }
      } catch {
        setFaceStatus("fallback");
        setFaceText("Klik Ambil Foto Selfie untuk menyimpan foto.");
        return;
      }
      faceRafRef.current = requestAnimationFrame(loop);
    };
    faceRafRef.current = requestAnimationFrame(loop);
  }, []);

  const openSelfieCamera = async () => {
    try {
      stopQrCam();
      setCapturedSelfie(null);
      setSelfieCameraOn(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 480 },
          height: { ideal: 480 },
        },
        audio: false,
      });
      if (selfieVideoRef.current) {
        selfieVideoRef.current.srcObject = stream;
        await selfieVideoRef.current.play();
      }
      runFaceLoop();
    } catch {
      setSelfieCameraOn(false);
      notify("err", "Izinkan kamera depan untuk selfie pendeteksi wajah.");
    }
  };

  const takeSelfiePhoto = async () => {
    if (!selfieVideoRef.current || !selfieCanvasRef.current) return;
    const FD = (
      window as unknown as {
        FaceDetector?: new (opts?: {
          fastMode?: boolean;
          maxDetectedFaces?: number;
        }) => FaceDetectorInstance;
      }
    ).FaceDetector;

    let detected = faceStatus === "detected";
    if (!detected && FD) {
      try {
        const detector = new FD({ fastMode: true, maxDetectedFaces: 1 });
        const faces = await detector.detect(selfieVideoRef.current);
        detected = faces.length > 0;
      } catch {
        detected = false;
      }
    }

    if (FD && !detected) {
      setFaceStatus("no_face");
      setFaceText("Wajah tidak terdeteksi. Arahkan wajah ke kamera.");
      notify("err", "Wajah belum terdeteksi!");
      return;
    }

    const c = selfieCanvasRef.current;
    c.width = 240;
    c.height = 240;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(selfieVideoRef.current, 0, 0, 240, 240);
    const dataUrl = c.toDataURL("image/jpeg", 0.65);
    setCapturedSelfie(dataUrl);
    setFaceStatus(FD ? "detected" : "fallback");
    setFaceText("Selfie wajah tersimpan.");
    stopSelfieCam();
    notify("ok", "Selfie wajah berhasil diambil.");
  };

  const submitAttendance = async (
    typeOverride?: "CLOCK_IN" | "CLOCK_OUT",
    manualCodeOverride?: string
  ) => {
    if (!activeUser) return;
    const syncedNow = Date.now() + offsetRef.current;
    setNowMs(syncedNow);

    if (cooldownInfo.locked) {
      notify(
        "err",
        `Sudah absen ${
          cooldownInfo.lastEntry?.entry_type === "CLOCK_IN" ? "MASUK" : "KELUAR"
        }. Absen normal lagi setelah 6 jam (sisa ${cooldownInfo.remainingText}).`
      );
      return;
    }

    const entryType = typeOverride || selectedAction;
    const enteredCode = (manualCodeOverride ?? qrInput).trim().toUpperCase();
    const effectiveQr =
      enteredCode ||
      officeQrCode.trim().toUpperCase() ||
      "ABSENSI-KANTOR-MPI-BTG";

    if (enteredCode && enteredCode !== officeQrCode.trim().toUpperCase()) {
      notify(
        "err",
        `Kode Barcode/QR salah! Gunakan QR resmi (${officeQrCode}).`
      );
      return;
    }

    if (isKaryawanMode) {
      if (!gpsCoords) {
        notify("err", "Aktifkan GPS lokasi untuk memverifikasi titik absen.");
        return;
      }
      if (geofence && !geofence.inside) {
        notify(
          "err",
          `Di luar radius kantor (${geofence.distance}m > ${targetLocation.radius_meters}m).`
        );
        return;
      }
      if (!capturedSelfie) {
        notify("err", "Wajib ambil foto selfie deteksi wajah sebelum absen.");
        return;
      }
    }

    const punchedAtIso = new Date(syncedNow).toISOString();
    const uuid =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${syncedNow}-${Math.random().toString(36).slice(2)}`;

    const newPunch: TimeEntry = {
      client_uuid: uuid,
      employee_id: Number(activeUser.id),
      entry_type: entryType,
      punched_at: punchedAtIso,
      is_offline_sync: !navigator.onLine,
      qr_code: effectiveQr,
      mode: capturedSelfie
        ? "BARCODE + WAJAH"
        : enteredCode
        ? "BARCODE + GPS"
        : "MANUAL KLIK",
      latitude: gpsCoords?.lat ?? targetLocation.latitude,
      longitude: gpsCoords?.lng ?? targetLocation.longitude,
      distance_meters: geofence?.distance ?? 0,
      is_within_geofence: geofence ? geofence.inside : true,
      selfie_data: capturedSelfie,
      face_detected: Boolean(capturedSelfie && faceStatus !== "no_face"),
      full_name: activeUser.full_name,
      emp_code: activeUser.emp_code,
    };

    const nextQueue = [newPunch, ...offlineQueue];
    setOfflineQueue(nextQueue);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(nextQueue));
    setQrInput("");
    setCapturedSelfie(null);
    setFaceStatus("idle");
    setFaceText("Arahkan wajah ke kamera depan lalu klik Ambil Foto Selfie.");

    if (navigator.onLine) {
      await syncOfflineQueue(nextQueue, true);
      await refreshServer(true);
    }
    notify(
      "ok",
      entryType === "CLOCK_IN"
        ? "Absen MASUK tercatat sesuai jam WIB!"
        : "Absen KELUAR tercatat sesuai jam WIB!"
    );
  };

  const lockDeviceToKaryawan = () => {
    stopQrCam();
    stopSelfieCam();
    localStorage.setItem(DEVICE_LOCK_KEY, "1");
    localStorage.removeItem(AUTH_SERVER_KEY);
    setIsDeviceLockedKaryawan(true);
    setIsPrivilegedAuthed(false);
    setServerMode("KARYAWAN");
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("server", "karyawan");
      window.history.replaceState({}, "", url.toString());
    }
    notify(
      "ok",
      "Perangkat dikunci ke Server Karyawan (Mode Terbatas). Akses Manager & Admin diblokir."
    );
  };

  const verifyPrivilegedLogin = () => {
    const expectedPin =
      activeUser?.pin_code || (isManagerServer ? "2026" : "0000");
    if (pinEntry.trim() === expectedPin) {
      localStorage.setItem(AUTH_SERVER_KEY, serverMode);
      setIsPrivilegedAuthed(true);
      setPinEntry("");
      notify("ok", `Login ${serverMode} berhasil.`);
    } else {
      notify("err", `PIN ${serverMode} salah.`);
    }
  };

  const todayStr = getJakartaDateStr(syncedIsoNow);

  const summaryToday = useMemo(() => {
    const todayEntries = allEntries.filter(
      (e) => getJakartaDateStr(e.punched_at) === todayStr
    );
    const inIds = new Set<number>();
    const outIds = new Set<number>();
    let lateCount = 0;

    for (const item of todayEntries) {
      const emp = employees.find(
        (e) => Number(e.id) === Number(item.employee_id)
      );
      if (item.entry_type === "CLOCK_IN") {
        inIds.add(Number(item.employee_id));
        if (
          calcLateMinutes(item.punched_at, emp?.shift_start_time || "07.00") > 0
        ) {
          lateCount++;
        }
      } else if (item.entry_type === "CLOCK_OUT") {
        outIds.add(Number(item.employee_id));
      }
    }

    return {
      masuk: inIds.size,
      terlambat: lateCount,
      keluar: outIds.size,
    };
  }, [allEntries, todayStr, employees]);

  const filteredEntries = useMemo(() => {
    const limitDays =
      reportFilter === "Harian" ? 1 : reportFilter === "Mingguan" ? 7 : 31;
    const minMs = nowMs - limitDays * 86400000;
    return allEntries.filter((e) => {
      if (reportFilter === "Harian") {
        return getJakartaDateStr(e.punched_at) === todayStr;
      }
      return new Date(e.punched_at).getTime() >= minMs;
    });
  }, [allEntries, reportFilter, todayStr, nowMs]);

  const handleScheduleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScheduleFileName(file.name);
    try {
      const isPdf =
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf");
      let parsed: Array<{
        emp_code: string;
        full_name: string;
        shift_time: string;
      }> = [];

      if (isPdf) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        parsed = parseScheduleLines(extractLinesFromPdfBytes(bytes));
      } else {
        const text = await file.text();
        parsed = parseScheduleLines(
          text
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
        );
      }

      setSchedulePreview(parsed);
      if (parsed.length > 0) {
        const updated = employees.map((emp) => {
          const match = parsed.find(
            (r) =>
              r.emp_code.toLowerCase() === emp.emp_code.toLowerCase() ||
              r.full_name.toLowerCase() === emp.full_name.toLowerCase()
          );
          return match
            ? { ...emp, shift_start_time: normalizeShiftTime(match.shift_time) }
            : emp;
        });
        setEmployees(updated);
        notify("ok", `${parsed.length} jadwal dimuat dari ${file.name}.`);
      } else {
        notify("warn", `File ${file.name} dibaca tanpa baris jadwal cocok.`);
      }
    } catch {
      notify("err", `Gagal memproses ${file.name}.`);
    } finally {
      if (scheduleInputRef.current) scheduleInputRef.current.value = "";
    }
  };

  const exportReport = (format: "XLSX" | "CSV" | "PDF") => {
    if (isKaryawanMode) return;
    if (format === "PDF") {
      window.print();
      return;
    }
    const headers = [
      "Tanggal",
      "Nama",
      "Jenis",
      "Scan",
      "Telat",
      "Status",
      "Mode",
    ];
    const rows = filteredEntries.map((item) => {
      const emp = employees.find(
        (e) => Number(e.id) === Number(item.employee_id)
      );
      const lateMins = calcLateMinutes(
        item.punched_at,
        emp?.shift_start_time || "07.00"
      );
      return [
        getJakartaDateStr(item.punched_at),
        item.full_name || emp?.full_name || "Karyawan",
        item.entry_type === "CLOCK_IN" ? "MASUK" : "KELUAR",
        formatTimeWIB(item.punched_at),
        lateMins > 0 ? `${lateMins}m` : "0m",
        item.is_within_geofence === false ? "LUAR RADIUS" : "HADIR",
        item.mode || "BARCODE + GPS",
      ];
    });

    if (format === "CSV") {
      const csv = [headers, ...rows]
        .map((r) =>
          r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")
        )
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Laporan_Absensi_${reportFilter}_${todayStr}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    const html = `<table border="1"><tr>${headers
      .map((h) => `<th>${h}</th>`)
      .join("")}</tr>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("")}</table>`;
    const blob = new Blob([html], { type: "application/vnd.ms-excel" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Laporan_Absensi_${reportFilter}_${todayStr}.xls`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startEditEntry = (item: TimeEntry) => {
    if (isKaryawanMode) return;
    setEditingUuid(item.client_uuid);
    setEditId(item.id);
    setEditType(item.entry_type);
    setEditTimeLocal(formatDateTimeLocalWIB(item.punched_at));
    setEditNotes(item.notes || "");
  };

  const commitEditEntry = async () => {
    if (isKaryawanMode || !editingUuid) return;
    const d = editTimeLocal
      ? new Date(`${editTimeLocal}:00+07:00`)
      : new Date(nowMs);
    const nextIso = isNaN(d.getTime())
      ? new Date(nowMs).toISOString()
      : d.toISOString();

    setServerEntries((prev) =>
      prev.map((x) =>
        x.client_uuid === editingUuid
          ? { ...x, entry_type: editType, punched_at: nextIso, notes: editNotes }
          : x
      )
    );
    setOfflineQueue((prev) => {
      const next = prev.map((x) =>
        x.client_uuid === editingUuid
          ? { ...x, entry_type: editType, punched_at: nextIso, notes: editNotes }
          : x
      );
      localStorage.setItem(QUEUE_KEY, JSON.stringify(next));
      return next;
    });

    if (navigator.onLine) {
      try {
        await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "UPDATE_ENTRY",
            payload: {
              id: editId,
              client_uuid: editingUuid,
              entry_type: editType,
              punched_at: nextIso,
              notes: editNotes,
            },
          }),
        });
        await refreshServer(true);
      } catch {
        // Pertahankan lokal
      }
    }
    setEditingUuid(null);
    notify("ok", "Waktu & data absen diperbarui.");
  };

  const removeEntry = async (item: TimeEntry) => {
    if (isKaryawanMode) return;
    setServerEntries((prev) =>
      prev.filter(
        (x) =>
          x.client_uuid !== item.client_uuid && (!item.id || x.id !== item.id)
      )
    );
    setOfflineQueue((prev) => {
      const next = prev.filter((x) => x.client_uuid !== item.client_uuid);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(next));
      return next;
    });
    if (navigator.onLine) {
      try {
        await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "DELETE_ENTRY",
            payload: { id: item.id, client_uuid: item.client_uuid },
          }),
        });
        await refreshServer(true);
      } catch {
        // Abaikan error
      }
    }
    notify("ok", "Data absen dihapus.");
  };

  const saveEmployee = async () => {
    if (
      isKaryawanMode ||
      !empForm.emp_code.trim() ||
      !empForm.full_name.trim()
    ) {
      notify("err", "Isi ID dan Nama Lengkap karyawan.");
      return;
    }
    const payload = {
      id: empForm.id || undefined,
      emp_code: empForm.emp_code.trim(),
      full_name: empForm.full_name.trim(),
      role: empForm.role,
      department: empForm.department.trim() || "Operasional",
      pin_code: empForm.pin_code.trim() || "1234",
      shift_start_time: normalizeShiftTime(empForm.shift_start_time),
    };
    if (navigator.onLine) {
      try {
        const res = await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "SAVE_EMPLOYEE", payload }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.ok) {
            await refreshServer(true);
            setEmpForm({
              id: 0,
              emp_code: "",
              full_name: "",
              role: "STAFF",
              department: "Operasional",
              pin_code: "1234",
              shift_start_time: "07.00",
            });
            notify("ok", "Data karyawan disimpan.");
            return;
          }
        }
      } catch {
        // Fallback lokal
      }
    }
    setEmployees((prev) => {
      if (empForm.id) {
        return prev.map((e) => (e.id === empForm.id ? { ...e, ...payload } : e));
      }
      return [...prev, { ...payload, id: Date.now() }];
    });
    setEmpForm({
      id: 0,
      emp_code: "",
      full_name: "",
      role: "STAFF",
      department: "Operasional",
      pin_code: "1234",
      shift_start_time: "07.00",
    });
    notify("ok", "Data karyawan diperbarui.");
  };

  const deleteEmployee = async (id: number) => {
    if (isKaryawanMode) return;
    if (navigator.onLine) {
      try {
        await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "DELETE_EMPLOYEE", payload: { id } }),
        });
        await refreshServer(true);
      } catch {
        // Abaikan error
      }
    }
    setEmployees((prev) => prev.filter((e) => e.id !== id));
    notify("ok", "Anggota karyawan dihapus.");
  };

  const fillFromCurrentGps = () => {
    if (!("geolocation" in navigator)) {
      notify("err", "GPS tidak tersedia di perangkat ini.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(7));
        const lng = Number(pos.coords.longitude.toFixed(7));
        setLatInput(String(lat));
        setLngInput(String(lng));
        setGpsCoords({ lat, lng });
        notify("ok", `Koordinat terisi dari GPS: ${lat}, ${lng}`);
      },
      () => {
        notify("err", "Gagal membaca GPS saat ini.");
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 }
    );
  };

  const saveCustomLocation = async () => {
    if (isKaryawanMode) return;
    const parsedLat = Number(String(latInput).replace(",", "."));
    const parsedLng = Number(String(lngInput).replace(",", "."));
    const parsedRadius = Math.max(10, Number(radiusInput) || DEFAULT_RADIUS);

    if (
      isNaN(parsedLat) ||
      isNaN(parsedLng) ||
      parsedLat < -90 ||
      parsedLat > 90 ||
      parsedLng < -180 ||
      parsedLng > 180
    ) {
      notify(
        "err",
        "Masukkan Latitude (-90 s/d 90) dan Longitude (-180 s/d 180) yang valid."
      );
      return;
    }

    const locPayload: LocationItem = {
      id: locations[0]?.id || 1,
      name: locations[0]?.name || "Kantor Utama",
      latitude: parsedLat,
      longitude: parsedLng,
      radius_meters: parsedRadius,
    };

    setLocations([locPayload]);
    setLatInput(String(parsedLat));
    setLngInput(String(parsedLng));
    setRadiusInput(String(parsedRadius));
    localStorage.setItem(LOC_KEY, JSON.stringify(locPayload));

    if (navigator.onLine) {
      try {
        await fetch("/api/absen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "SAVE_LOCATION",
            payload: locPayload,
          }),
        });
      } catch {
        // Tetap tersimpan lokal
      }
    }
    notify(
      "ok",
      `Titik koordinat diperbarui: ${parsedLat}, ${parsedLng} (Radius ${parsedRadius}m)`
    );
  };

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
    officeQrCode
  )}`;

  const myRecentEntries = useMemo(() => {
    if (!activeUser) return [];
    return allEntries
      .filter((e) => Number(e.employee_id) === Number(activeUser.id))
      .slice(0, 5);
  }, [allEntries, activeUser]);

  if (!isKaryawanMode && !isPrivilegedAuthed) {
    return (
      <div className="min-h-screen bg-[#ECEFF4] flex items-center justify-center p-4">
        <div className="max-w-sm w-full bg-white rounded-2xl p-5 shadow space-y-3.5 border border-slate-200">
          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold uppercase text-slate-900">
              {isManagerServer ? "Server Manager" : "Server Administrator"}
            </span>
            <span
              className={`px-2 py-0.5 rounded text-[9px] font-extrabold ${
                isManagerServer
                  ? "bg-amber-100 text-amber-800"
                  : "bg-indigo-100 text-indigo-800"
              }`}
            >
              {serverMode}
            </span>
          </div>

          <div className="text-[11px] font-mono text-emerald-700 bg-emerald-50 px-2.5 py-1.5 rounded-lg">
            {indonesiaClockWIB}
          </div>

          {toast && (
            <div className="px-3 py-2 rounded-lg bg-rose-600 text-white text-xs font-bold">
              {toast.text}
            </div>
          )}

          <p className="text-xs text-slate-500">
            Masukkan PIN {serverMode} ({activeUser?.full_name}) untuk akses penuh
            dasbor.
          </p>

          <input
            type="password"
            inputMode="numeric"
            placeholder={
              isManagerServer
                ? "PIN Manager (default: 2026)"
                : "PIN Admin (default: 0000)"
            }
            value={pinEntry}
            onChange={(e) => setPinEntry(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-center tracking-widest"
          />

          <button
            type="button"
            onClick={verifyPrivilegedLogin}
            className="w-full py-2.5 rounded-lg bg-blue-600 text-white text-xs font-extrabold"
          >
            Buka Server {serverMode}
          </button>

          <div className="grid grid-cols-2 gap-1.5 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => {
                setServerMode(isManagerServer ? "ADMIN" : "MANAGER");
                setPinEntry("");
              }}
              className="py-1.5 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold"
            >
              {isManagerServer ? "Ke Server Admin" : "Ke Server Manager"}
            </button>
            <button
              type="button"
              onClick={lockDeviceToKaryawan}
              className="py-1.5 rounded-lg bg-sky-100 text-sky-800 text-[11px] font-bold"
            >
              Kunci HP Karyawan
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#ECEFF4] text-slate-900 p-2.5 sm:p-4">
      <div className="max-w-md mx-auto space-y-3.5">
        {toast && (
          <div
            className={`px-4 py-2.5 rounded-xl text-white text-xs font-bold shadow ${
              toast.type === "ok"
                ? "bg-emerald-600"
                : toast.type === "warn"
                ? "bg-amber-600"
                : "bg-rose-600"
            }`}
          >
            {toast.text}
          </div>
        )}

        <header className="bg-[#0B1220] text-white rounded-2xl p-3.5 shadow space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h1 className="text-sm font-extrabold tracking-wide uppercase">
                APLIKASI ABSENSI QR &amp; GPS
              </h1>
              <p className="text-[11px] text-slate-300 mt-0.5">
                {activeUser?.full_name} ({activeUser?.emp_code}) •{" "}
                {isKaryawanMode ? "KARYAWAN" : serverMode}
              </p>
            </div>
            <span
              className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase shrink-0 ${
                isAdminServer
                  ? "bg-indigo-500 text-white"
                  : isManagerServer
                  ? "bg-amber-500 text-slate-950"
                  : "bg-sky-600 text-white"
              }`}
            >
              {isAdminServer
                ? "SERVER ADMIN • FULL"
                : isManagerServer
                ? "SERVER MANAGER • FULL"
                : "SERVER KARYAWAN • TERBATAS"}
            </span>
          </div>

          <div className="text-[11px] font-mono text-emerald-300 bg-white/5 px-2.5 py-1.5 rounded-lg">
            {indonesiaClockWIB}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`px-2.5 py-1 rounded-md text-white text-[10px] font-extrabold uppercase ${
                dbConnected ? "bg-emerald-600" : "bg-amber-600"
              }`}
            >
              {isOnline ? (dbConnected ? "DB NEON AKTIF" : "MODE LOKAL") : "OFFLINE"} •
              ANTREAN: {offlineQueue.length}
            </span>
            <button
              type="button"
              onClick={() => {
                void refreshServer(false);
                requestCurrentGps();
              }}
              disabled={isSyncing}
              className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold"
            >
              {isSyncing ? "Sinkron..." : "Refresh Server"}
            </button>

            {!isKaryawanMode && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const nextMode: ServerMode = isAdminServer
                      ? "MANAGER"
                      : "ADMIN";
                    localStorage.removeItem(AUTH_SERVER_KEY);
                    setIsPrivilegedAuthed(false);
                    setServerMode(nextMode);
                  }}
                  className="px-2.5 py-1 rounded-md bg-amber-500 text-slate-950 text-[10px] font-extrabold"
                >
                  {isAdminServer ? "Server Manager" : "Server Admin"}
                </button>
                <button
                  type="button"
                  onClick={lockDeviceToKaryawan}
                  className="px-2.5 py-1 rounded-md bg-sky-600 text-white text-[10px] font-bold"
                >
                  Mode HP Karyawan
                </button>
                <button
                  type="button"
                  onClick={() => {
                    localStorage.removeItem(AUTH_SERVER_KEY);
                    setIsPrivilegedAuthed(false);
                  }}
                  className="px-2.5 py-1 rounded-md bg-rose-600 text-white text-[10px] font-bold"
                >
                  Keluar
                </button>
              </>
            )}
          </div>
        </header>

        {isKaryawanMode && (
          <section className="bg-white rounded-2xl p-3 border border-slate-200/80 shadow-sm space-y-1.5">
            <label className="block text-[11px] font-extrabold text-slate-700">
              Pilih Nama Karyawan
            </label>
            <select
              value={activeUser?.id || ""}
              onChange={(e) => {
                const nextId = Number(e.target.value);
                setStaffEmpId(nextId);
                localStorage.setItem(STAFF_EMP_KEY, String(nextId));
              }}
              className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-bold bg-slate-50"
            >
              {staffList.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.full_name} ({emp.emp_code}) • Shift{" "}
                  {emp.shift_start_time || "07.00"}
                </option>
              ))}
            </select>
          </section>
        )}

        {!isKaryawanMode && (
          <section className="bg-white rounded-2xl p-3.5 border-t-4 border-t-blue-600 border border-slate-200/80 shadow-sm space-y-2.5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-extrabold text-slate-800">
                Monitoring Kehadiran Hari Ini ({todayStr})
              </h2>
              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[9px] font-extrabold uppercase">
                LIVE SERVER
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2.5 rounded-xl bg-blue-50/80 border border-blue-100">
                <div className="text-base font-extrabold text-blue-700">
                  {summaryToday.masuk}
                </div>
                <div className="text-[10px] text-slate-500 font-medium">
                  Absen Masuk
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-amber-50/80 border border-amber-100">
                <div className="text-base font-extrabold text-amber-600">
                  {summaryToday.terlambat}
                </div>
                <div className="text-[10px] text-slate-500 font-medium">
                  Terlambat
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-emerald-50/80 border border-emerald-100">
                <div className="text-base font-extrabold text-emerald-700">
                  {summaryToday.keluar}
                </div>
                <div className="text-[10px] text-slate-500 font-medium">
                  Absen Keluar
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="bg-white rounded-2xl p-3.5 border-t-4 border-t-blue-500 border border-slate-200/80 shadow-sm space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-extrabold text-slate-800">
              1. Scan Barcode/QR &amp; GPS Realtime
            </h2>
            <button
              type="button"
              onClick={requestCurrentGps}
              className="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-bold"
            >
              Ambil GPS
            </button>
          </div>

          <div className="text-[11px] text-slate-500">
            Jadwal Masuk: {activeUser?.shift_start_time || "07.00"}
          </div>
          <div className="text-[11px] font-bold text-emerald-700">
            {geofenceLabel}
          </div>
          <div className="text-[10px] text-slate-500">
            Titik Kantor Aktif: Lat {targetLocation.latitude}, Lng{" "}
            {targetLocation.longitude} • Radius {targetLocation.radius_meters}m
          </div>

          {cooldownInfo.locked && (
            <div className="p-2 rounded-xl bg-amber-50 border border-amber-300 text-[11px] font-bold text-amber-900">
              Sudah absen{" "}
              {cooldownInfo.lastEntry?.entry_type === "CLOCK_IN"
                ? "MASUK"
                : "KELUAR"}
              . Absen normal lagi setelah 6 jam (sisa{" "}
              {cooldownInfo.remainingText}).
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={cooldownInfo.locked}
              onClick={() => {
                setSelectedAction("CLOCK_IN");
                void submitAttendance("CLOCK_IN");
              }}
              className={`py-2 rounded-lg text-xs font-extrabold border disabled:opacity-45 ${
                selectedAction === "CLOCK_IN" && !cooldownInfo.locked
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-slate-700 border-slate-300"
              }`}
            >
              MASUK
            </button>
            <button
              type="button"
              disabled={cooldownInfo.locked}
              onClick={() => {
                setSelectedAction("CLOCK_OUT");
                void submitAttendance("CLOCK_OUT");
              }}
              className={`py-2 rounded-lg text-xs font-extrabold border disabled:opacity-45 ${
                selectedAction === "CLOCK_OUT" && !cooldownInfo.locked
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-slate-700 border-slate-300"
              }`}
            >
              KELUAR
            </button>
          </div>

          <button
            type="button"
            disabled={cooldownInfo.locked}
            onClick={() =>
              qrCameraOn ? stopQrCam() : void startScannerCamera()
            }
            className="w-full py-2.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-45 text-white text-xs font-bold"
          >
            {qrCameraOn
              ? "Tutup Scanner Barcode/QR"
              : "Buka Scanner Barcode / QR"}
          </button>

          {qrCameraOn && (
            <div className="w-44 h-44 mx-auto rounded-xl overflow-hidden bg-black border-2 border-emerald-600">
              <video
                ref={qrVideoRef}
                playsInline
                muted
                className="w-full h-full object-cover"
              />
            </div>
          )}

          <div className="flex gap-1.5">
            <input
              type="text"
              disabled={cooldownInfo.locked}
              placeholder="Input Kode Barcode/QR manual jika kamera terkendala"
              value={qrInput}
              onChange={(e) => setQrInput(e.target.value)}
              className="flex-1 rounded-lg border border-slate-300 px-2.5 py-2 text-xs disabled:bg-slate-100"
            />
            <button
              type="button"
              disabled={cooldownInfo.locked}
              onClick={() => void submitAttendance(selectedAction, qrInput)}
              className="px-3.5 py-2 rounded-lg bg-slate-900 disabled:opacity-45 text-white text-xs font-bold"
            >
              Kirim
            </button>
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-extrabold text-slate-700">
                Selfie Pendeteksi Wajah{" "}
                {isKaryawanMode ? "(Wajib Karyawan)" : "(Opsional)"}
              </span>
              {capturedSelfie && (
                <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                  Siap
                </span>
              )}
            </div>
            <p
              className={`text-[10px] font-semibold ${
                faceStatus === "detected"
                  ? "text-emerald-700"
                  : faceStatus === "no_face"
                  ? "text-rose-600"
                  : "text-slate-500"
              }`}
            >
              {faceText}
            </p>

            {selfieCameraOn && (
              <div className="space-y-1.5">
                <div className="w-44 h-44 mx-auto rounded-xl overflow-hidden bg-black border-2 border-blue-600">
                  <video
                    ref={selfieVideoRef}
                    playsInline
                    muted
                    className="w-full h-full object-cover scale-x-[-1]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => void takeSelfiePhoto()}
                    className="py-2 rounded-lg bg-blue-600 text-white text-xs font-bold"
                  >
                    Ambil Foto Selfie
                  </button>
                  <button
                    type="button"
                    onClick={stopSelfieCam}
                    className="py-2 rounded-lg bg-slate-200 text-slate-800 text-xs font-bold"
                  >
                    Batal
                  </button>
                </div>
              </div>
            )}

            {!selfieCameraOn && (
              <button
                type="button"
                disabled={cooldownInfo.locked}
                onClick={() => void openSelfieCamera()}
                className="w-full py-2 rounded-lg bg-slate-800 hover:bg-slate-900 disabled:opacity-45 text-white text-xs font-bold"
              >
                {capturedSelfie
                  ? "Ambil Ulang Selfie Wajah"
                  : "Buka Kamera Selfie Wajah"}
              </button>
            )}

            {capturedSelfie && !selfieCameraOn && (
              <div className="flex items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={capturedSelfie}
                  alt="Selfie Wajah"
                  className="w-12 h-12 rounded-lg object-cover border border-emerald-500"
                />
                <span className="text-[11px] text-emerald-800 font-semibold">
                  Selfie tersimpan. Klik MASUK atau KELUAR.
                </span>
              </div>
            )}
            <canvas ref={selfieCanvasRef} className="hidden" />
          </div>

          {isKaryawanMode && (
            <div className="pt-2 border-t border-slate-100 space-y-1">
              <div className="text-[10px] font-bold text-slate-500 uppercase">
                Riwayat Absen Saya (WIB)
              </div>
              {myRecentEntries.length === 0 ? (
                <div className="text-[11px] text-slate-400">
                  Belum ada catatan absen.
                </div>
              ) : (
                myRecentEntries.map((row, idx) => (
                  <div
                    key={`${row.client_uuid}-${idx}`}
                    className="flex items-center justify-between text-[11px] bg-slate-50 px-2.5 py-1.5 rounded-lg"
                  >
                    <span className="font-bold">
                      {row.entry_type === "CLOCK_IN" ? "MASUK" : "KELUAR"}
                    </span>
                    <span className="text-slate-600">
                      {formatTimeWIB(row.punched_at)} WIB
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </section>

        {!isKaryawanMode && (
          <>
            <section className="bg-white rounded-2xl p-3.5 border border-slate-200/80 shadow-sm space-y-2">
              <h2 className="text-xs font-extrabold text-slate-800">
                2. Input Jadwal (.PDF / .XLSX / .CSV)
              </h2>
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 p-1.5 bg-slate-50">
                <button
                  type="button"
                  onClick={() => scheduleInputRef.current?.click()}
                  className="px-2.5 py-1 rounded bg-slate-200 hover:bg-slate-300 text-slate-800 text-[11px] font-bold shrink-0"
                >
                  Pilih File
                </button>
                <span className="text-[11px] text-slate-500 truncate">
                  {scheduleFileName}
                </span>
                <input
                  ref={scheduleInputRef}
                  type="file"
                  accept=".pdf,.xlsx,.xls,.csv,.txt"
                  onChange={(e) => void handleScheduleFile(e)}
                  className="hidden"
                />
              </div>
              {schedulePreview.length > 0 && (
                <div className="space-y-1 pt-1">
                  {schedulePreview.map((r, idx) => (
                    <div
                      key={`${r.emp_code}-${idx}`}
                      className="text-[10px] bg-emerald-50 text-emerald-900 px-2.5 py-1 rounded flex justify-between font-semibold"
                    >
                      <span>
                        {r.full_name} ({r.emp_code})
                      </span>
                      <span>Shift {r.shift_time}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="bg-white rounded-2xl p-3.5 border border-slate-200/80 shadow-sm space-y-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-extrabold text-slate-800">
                  3. Laporan &amp; Data Absensi:
                </h2>
                <select
                  value={reportFilter}
                  onChange={(e) =>
                    setReportFilter(
                      e.target.value as "Harian" | "Mingguan" | "Bulanan"
                    )
                  }
                  className="rounded-lg border border-slate-300 px-2 py-1 text-[11px] font-semibold bg-white"
                >
                  <option value="Harian">Harian</option>
                  <option value="Mingguan">Mingguan</option>
                  <option value="Bulanan">Bulanan</option>
                </select>
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={() => exportReport("XLSX")}
                  className="py-2 rounded-lg bg-emerald-700 text-white text-[11px] font-bold"
                >
                  Download XLSX
                </button>
                <button
                  type="button"
                  onClick={() => exportReport("PDF")}
                  className="py-2 rounded-lg bg-rose-600 text-white text-[11px] font-bold"
                >
                  Download PDF
                </button>
                <button
                  type="button"
                  onClick={() => exportReport("CSV")}
                  className="py-2 rounded-lg bg-slate-800 text-white text-[11px] font-bold"
                >
                  Download CSV
                </button>
              </div>

              {editingUuid && (
                <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-300 space-y-2">
                  <div className="text-[11px] font-extrabold text-amber-900">
                    Edit Catatan Absensi
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <select
                      value={editType}
                      onChange={(e) =>
                        setEditType(e.target.value as "CLOCK_IN" | "CLOCK_OUT")
                      }
                      className="rounded-lg border px-2 py-1.5 text-xs bg-white"
                    >
                      <option value="CLOCK_IN">MASUK</option>
                      <option value="CLOCK_OUT">KELUAR</option>
                    </select>
                    <input
                      type="datetime-local"
                      value={editTimeLocal}
                      onChange={(e) => setEditTimeLocal(e.target.value)}
                      className="rounded-lg border px-2 py-1.5 text-xs bg-white"
                    />
                  </div>
                  <input
                    type="text"
                    placeholder="Catatan edit"
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    className="w-full rounded-lg border px-2.5 py-1.5 text-xs bg-white"
                  />
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => void commitEditEntry()}
                      className="px-3 py-1 rounded-lg bg-emerald-600 text-white text-xs font-bold"
                    >
                      Simpan
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingUuid(null)}
                      className="px-3 py-1 rounded-lg bg-slate-200 text-slate-800 text-xs font-bold"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-left border-collapse text-[10px]">
                  <thead>
                    <tr className="bg-[#0B1220] text-white">
                      <th className="p-1.5">Tanggal</th>
                      <th className="p-1.5">Nama</th>
                      <th className="p-1.5">Jenis</th>
                      <th className="p-1.5">Scan</th>
                      <th className="p-1.5">Telat</th>
                      <th className="p-1.5">Status</th>
                      <th className="p-1.5">Mode</th>
                      <th className="p-1.5">Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.length === 0 ? (
                      <tr>
                        <td
                          colSpan={8}
                          className="p-4 text-center text-slate-400"
                        >
                          Belum ada data absensi
                        </td>
                      </tr>
                    ) : (
                      filteredEntries.map((item, idx) => {
                        const emp = employees.find(
                          (e) => Number(e.id) === Number(item.employee_id)
                        );
                        const lateM = calcLateMinutes(
                          item.punched_at,
                          emp?.shift_start_time || "07.00"
                        );
                        return (
                          <tr
                            key={`${item.client_uuid}-${idx}`}
                            className="border-t border-slate-100"
                          >
                            <td className="p-1.5 whitespace-nowrap">
                              {getJakartaDateStr(item.punched_at)}
                            </td>
                            <td className="p-1.5 font-semibold whitespace-nowrap">
                              {item.full_name || emp?.full_name || "Karyawan"}
                            </td>
                            <td className="p-1.5 whitespace-nowrap">
                              {item.entry_type === "CLOCK_IN"
                                ? "MASUK"
                                : "KELUAR"}
                            </td>
                            <td className="p-1.5 whitespace-nowrap">
                              {formatTimeWIB(item.punched_at)}
                            </td>
                            <td className="p-1.5 whitespace-nowrap">
                              {lateM > 0 ? `${lateM}m` : "0m"}
                            </td>
                            <td className="p-1.5 whitespace-nowrap">
                              {item.is_within_geofence === false
                                ? "LUAR"
                                : "HADIR"}
                            </td>
                            <td className="p-1.5 whitespace-nowrap">
                              {item.mode || "BARCODE + GPS"}
                            </td>
                            <td className="p-1.5 whitespace-nowrap space-x-1">
                              <button
                                type="button"
                                onClick={() => startEditEntry(item)}
                                className="px-1.5 py-0.5 rounded bg-amber-500 text-white font-bold"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => void removeEntry(item)}
                                className="px-1.5 py-0.5 rounded bg-rose-600 text-white font-bold"
                              >
                                Hapus
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="bg-white rounded-2xl p-3.5 border-t-4 border-t-emerald-600 border border-slate-200/80 shadow-sm space-y-2.5 text-center">
              <h2 className="text-xs font-extrabold text-slate-800 text-left">
                4. QR Code Resmi Kantor Utama
              </h2>
              <p className="text-[10px] text-slate-500 text-left leading-relaxed">
                Cetak atau tampilkan QR Code ini di lokasi kantor. Sistem
                mengunci pemindaian agar karyawan hanya bisa absen{" "}
                <b>MASUK</b> dan <b>KELUAR</b> memakai QR resmi ini.
              </p>

              <input
                type="text"
                value={officeQrCode}
                onChange={(e) => {
                  setOfficeQrCode(e.target.value);
                  localStorage.setItem(QR_CODE_KEY, e.target.value);
                }}
                className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-center"
              />

              <div className="p-3 rounded-xl border border-slate-200 bg-white inline-block mx-auto">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrUrl}
                  alt="QR Code Resmi Kantor Utama"
                  className="w-40 h-40 mx-auto"
                />
                <div className="text-xs font-extrabold text-slate-900 mt-1.5">
                  {officeQrCode}
                </div>
                <div className="text-[10px] text-slate-400">
                  Titik: {targetLocation.latitude}, {targetLocation.longitude} •
                  Radius {targetLocation.radius_meters}m
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <a
                  href={qrUrl}
                  download={`${officeQrCode}.png`}
                  target="_blank"
                  rel="noreferrer"
                  className="py-2 rounded-lg bg-emerald-700 text-white text-xs font-bold"
                >
                  Download PNG
                </a>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="py-2 rounded-lg bg-slate-900 text-white text-xs font-bold"
                >
                  Cetak QR
                </button>
              </div>
            </section>

            <section className="bg-white rounded-2xl p-3.5 border border-slate-200/80 shadow-sm space-y-2.5">
              <h2 className="text-xs font-extrabold text-slate-800">
                5. Panel {isAdminServer ? "Admin" : "Manager"}: Data Karyawan
                &amp; Koordinat
              </h2>
              <div className="space-y-1.5">
                <input
                  type="text"
                  placeholder="ID (KRY-005)"
                  value={empForm.emp_code}
                  onChange={(e) =>
                    setEmpForm((p) => ({ ...p, emp_code: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                />
                <input
                  type="text"
                  placeholder="Nama Lengkap"
                  value={empForm.full_name}
                  onChange={(e) =>
                    setEmpForm((p) => ({ ...p, full_name: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                />
                <div className="grid grid-cols-3 gap-1.5">
                  <select
                    value={empForm.role}
                    onChange={(e) =>
                      setEmpForm((p) => ({
                        ...p,
                        role: e.target.value as RoleType,
                      }))
                    }
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs bg-white"
                  >
                    <option value="STAFF">STAFF</option>
                    <option value="MANAGER">MANAGER</option>
                    {isAdminServer && <option value="ADMIN">ADMIN</option>}
                  </select>
                  <input
                    type="text"
                    placeholder="PIN"
                    value={empForm.pin_code}
                    onChange={(e) =>
                      setEmpForm((p) => ({ ...p, pin_code: e.target.value }))
                    }
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                  />
                  <select
                    value={empForm.shift_start_time}
                    onChange={(e) =>
                      setEmpForm((p) => ({
                        ...p,
                        shift_start_time: e.target.value,
                      }))
                    }
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs bg-white"
                  >
                    {SHIFT_OPTIONS.map((opt) => (
                      <option key={opt.time} value={opt.time}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => void saveEmployee()}
                  className="w-full py-2 rounded-lg bg-blue-600 text-white text-xs font-bold"
                >
                  {empForm.id ? "Simpan Edit Karyawan" : "Simpan Karyawan"}
                </button>
              </div>

              <div className="space-y-1.5 pt-1">
                {employees.map((emp) => (
                  <div
                    key={emp.id}
                    className="p-2 rounded-lg bg-slate-50 border border-slate-200/70 flex flex-wrap items-center justify-between gap-1.5 text-xs"
                  >
                    <div>
                      <span className="font-bold">{emp.full_name}</span> (
                      {emp.emp_code}) • {emp.role} • Shift{" "}
                      {emp.shift_start_time || "07.00"}
                    </div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          setEmpForm({
                            id: emp.id,
                            emp_code: emp.emp_code,
                            full_name: emp.full_name,
                            role: emp.role,
                            department: emp.department,
                            pin_code: emp.pin_code,
                            shift_start_time: normalizeShiftTime(
                              emp.shift_start_time
                            ),
                          })
                        }
                        className="px-2 py-0.5 rounded bg-amber-500 text-white text-[10px] font-bold"
                      >
                        Edit
                      </button>
                      {emp.role !== "ADMIN" && (
                        <button
                          type="button"
                          onClick={() => void deleteEmployee(emp.id)}
                          className="px-2 py-0.5 rounded bg-rose-600 text-white text-[10px] font-bold"
                        >
                          Hapus
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="pt-2.5 border-t border-slate-100 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-extrabold text-slate-700">
                    Atur Titik Koordinat &amp; Radius
                  </span>
                  <button
                    type="button"
                    onClick={fillFromCurrentGps}
                    className="px-2 py-0.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-800 text-[10px] font-bold"
                  >
                    Isi dari GPS Saat Ini
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Latitude"
                    value={latInput}
                    onChange={(e) => setLatInput(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-mono"
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Longitude"
                    value={lngInput}
                    onChange={(e) => setLngInput(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-mono"
                  />
                  <input
                    type="number"
                    placeholder="Radius (m)"
                    value={radiusInput}
                    onChange={(e) => setRadiusInput(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void saveCustomLocation()}
                  className="w-full py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-bold"
                >
                  Simpan Titik Koordinat &amp; Radius
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
