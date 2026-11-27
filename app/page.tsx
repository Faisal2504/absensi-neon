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
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const SHIFT_OPTIONS = [
  { label: "Shift Pagi (07.00)", time: "07.00" },
  { label: "Shift Siang (15.00)", time: "15.00" },
  { label: "Shift Malam (23.00)", time: "23.00" },
];

const CACHE_KEY = "absensi_v7_cache";
const QUEUE_KEY = "absensi_v7_queue";
const QR_CODE_KEY = "absensi_v7_qr";
const LOC_KEY = "absensi_v7_custom_loc";
const DEVICE_LOCK_KEY = "absensi_v7_device_locked_karyawan";
const STAFF_EMP_KEY = "absensi_v7_staff_emp_id";
const AUTH_SERVER_KEY = "absensi_v7_auth_server";

function normalizeShiftTime(raw?: string | null): string {
  const s = String(raw || "").trim();
  if (!s) return "07.00";
  if (
    s.includes("15:00") ||
    s.includes("15.00") ||
    s.toLowerCase().includes("siang")
  )
    return "15.00";
  if (
    s.includes("23:00") ||
    s.includes("23.00") ||
    s.toLowerCase().includes("malam")
  )
    return "23.00";
  if (
    s.includes("07:00") ||
    s.includes("07.00") ||
    s.toLowerCase().includes("pagi")
  )
    return "07.00";
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
    radius_meters: 150,
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

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
) {
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

    let empCode = codeMatch ? codeMatch[1].toUpperCase() : "";
    let fullName = "";

    if (cols.length >= 2) {
      if (!empCode && /^[A-Z0-9_-]{2,12}$/i.test(cols[0])) {
        empCode = cols[0].toUpperCase();
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
      // Default langsung terbuka sebagai ADMIN agar tidak memblokir saat dibuka pertama kali; klik Keluar untuk kunci PIN
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
        locations = c.locations;
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

    const savedCustomLoc = localStorage.getItem(LOC_KEY);
    if (savedCustomLoc) {
      const parsedLoc = JSON.parse(savedCustomLoc);
      if (
        typeof parsedLoc.latitude === "number" &&
        !isNaN(parsedLoc.latitude) &&
        typeof parsedLoc.longitude === "number" &&
        !isNaN(parsedLoc.longitude)
      ) {
        locations = [
          {
            id: locations[0]?.id || 1,
            name: parsedLoc.name || locations[0]?.name || "Kantor Utama",
            latitude: parsedLoc.latitude,
            longitude: parsedLoc.longitude,
            radius_meters:
              Number(parsedLoc.radius_meters) ||
              locations[0]?.radius_meters ||
              150,
          },
        ];
      }
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

  // Sinkronisasi Jam Indonesia (WIB / Asia/Jakarta) Otomatis
  const [serverOffsetMs, setServerOffsetMs] = useState<number>(0);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [isSyncing, setIsSyncing] = useState(false);

  // 1. Scanner Barcode/QR + Selfie Pendeteksi Wajah + Manual Klik
  const [selectedAction, setSelectedAction] = useState<"CLOCK_IN" | "CLOCK_OUT">(
    "CLOCK_IN"
  );
  const [officeQrCode, setOfficeQrCode] = useState<string>(boot.qrCode);
  const [qrInput, setQrInput] = useState("");
  const [qrCameraOn, setQrCameraOn] = useState(false);
  const [gpsCoords, setGpsCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
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

  // 2. Input Jadwal (.PDF / .XLSX / .CSV)
  const [scheduleFileName, setScheduleFileName] = useState(
    "Tidak ada file yang dipilih"
  );
  const [schedulePreview, setSchedulePreview] = useState<
    Array<{ emp_code: string; full_name: string; shift_time: string }>
  >([]);

  // 3. Laporan & Data Absensi
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

  // 5. Panel Admin & Manager: Karyawan + Koordinat GPS Bebas Diatur
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
    String(boot.locations[0]?.radius_meters ?? 150)
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

  const notify = useCallback(
    (type: "ok" | "warn" | "err", text: string) => {
      setToast({ type, text });
      setTimeout(() => setToast(null), 4000);
    },
    []
  );

  // Sinkronisasi Jam Indonesia (WIB) setiap detik
  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now() + serverOffsetMs);
    }, 1000);
    return () => clearInterval(interval);
  }, [serverOffsetMs]);

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
        const res = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ punches: queue }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data?.ok) {
          localStorage.removeItem(QUEUE_KEY);
          setOfflineQueue([]);
          if (!silent) {
            notify("ok", `${data.syncedCount || queue.length} data tersinkron.`);
          }
        }
      } catch {
        // Tetap di antrean lokal agar tidak hilang
      } finally {
        setIsSyncing(false);
      }
    },
    [notify]
  );

  const refreshServer = useCallback(
    async (silent = false) => {
      if (!navigator.onLine) {
        setNowMs(Date.now() + serverOffsetMs);
        if (!silent) notify("warn", "Offline: jam WIB tersinkronisasi lokal.");
        return;
      }
      setIsSyncing(true);
      try {
        const rawQ = localStorage.getItem(QUEUE_KEY);
        const pending: TimeEntry[] = rawQ ? JSON.parse(rawQ) : [];
        if (pending.length > 0) await syncOfflineQueue(pending, true);

        const res = await fetch("/api/bootstrap", { cache: "no-store" });
        const headerDate = res.headers.get("date");
        let offset = serverOffsetMs;
        if (headerDate) {
          const srvMs = new Date(headerDate).getTime();
          if (!isNaN(srvMs)) {
            offset = srvMs - Date.now();
            setServerOffsetMs(offset);
          }
        }
        setNowMs(Date.now() + offset);

        if (res.ok) {
          const data = await res.json();
          if (data?.ok) {
            const nextEmps: Employee[] =
              Array.isArray(data.employees) && data.employees.length > 0
                ? data.employees.map((e: Employee) => ({
                    ...e,
                    role: normalizeRole(e.role),
                    shift_start_time: normalizeShiftTime(e.shift_start_time),
                  }))
                : employees;

            let nextLocs: LocationItem[] =
              Array.isArray(data.locations) && data.locations.length > 0
                ? data.locations
                : locations;

            try {
              const savedCustom = localStorage.getItem(LOC_KEY);
              if (savedCustom) {
                const cLoc = JSON.parse(savedCustom);
                if (
                  typeof cLoc.latitude === "number" &&
                  !isNaN(cLoc.latitude) &&
                  typeof cLoc.longitude === "number" &&
                  !isNaN(cLoc.longitude)
                ) {
                  nextLocs = [
                    {
                      id: nextLocs[0]?.id || 1,
                      name: cLoc.name || nextLocs[0]?.name || "Kantor Utama",
                      latitude: cLoc.latitude,
                      longitude: cLoc.longitude,
                      radius_meters:
                        Number(cLoc.radius_meters) ||
                        nextLocs[0]?.radius_meters ||
                        150,
                    },
                  ];
                }
              }
            } catch {
              // Abaikan
            }

            const nextEntries: TimeEntry[] = Array.isArray(data.entries)
              ? data.entries.map((item: TimeEntry) => ({
                  ...item,
                  entry_type: normalizeEntryType(item.entry_type),
                  client_uuid:
                    item.client_uuid ||
                    `srv-${item.id || Math.random().toString(36).slice(2)}`,
                }))
              : serverEntries;

            setEmployees(nextEmps);
            setLocations(nextLocs);
            setLatInput(String(nextLocs[0]?.latitude ?? DEFAULT_LAT));
            setLngInput(String(nextLocs[0]?.longitude ?? DEFAULT_LNG));
            setRadiusInput(String(nextLocs[0]?.radius_meters ?? 150));
            setServerEntries(nextEntries);
            localStorage.setItem(
              CACHE_KEY,
              JSON.stringify({
                employees: nextEmps,
                locations: nextLocs,
                entries: nextEntries,
              })
            );
            if (!silent) {
              notify("ok", "Jam WIB & data server tersinkronisasi.");
            }
          }
        }
      } catch {
        setNowMs(Date.now() + serverOffsetMs);
        if (!silent) {
          notify("warn", "Mode lokal/cache aktif; jam WIB tetap berjalan.");
        }
      } finally {
        setIsSyncing(false);
      }
    },
    [notify, syncOfflineQueue, serverOffsetMs, employees, locations, serverEntries]
  );

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
      radius_meters: Math.max(10, Number(loc.radius_meters) || 150),
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
      return `${gpsStatusText} • Target (${targetLocation.latitude}, ${targetLocation.longitude})`;
    }
    return `GPS: Jarak ${geofence.distance}m (${
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

  // Kunci absen ganda selama 6 jam
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
    const syncedNow = Date.now() + serverOffsetMs;
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

    // Jika input QR kosong saat klik langsung MASUK/KELUAR, gunakan kode QR resmi agar manual klik tetap lancar
    const effectiveQr =
      enteredCode || officeQrCode.trim().toUpperCase() || "ABSENSI-KANTOR-MPI-BTG";

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
        ? "Absen MASUK tercatat sesuai jam WIB
