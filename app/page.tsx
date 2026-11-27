"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

type RoleType = "ADMIN" | "MANAGER" | "STAFF";
type IndoTzType = "Asia/Jakarta" | "Asia/Makassar" | "Asia/Jayapura";

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
  ) => Promise<Array<{ rawValue?: string; format?: string }>>;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const SHIFT_OPTIONS = [
  { label: "Shift Pagi (07.00)", time: "07.00" },
  { label: "Shift Siang (15.00)", time: "15.00" },
  { label: "Shift Malam (23.00)", time: "23.00" },
];

const CACHE_KEY = "absensi_role_lock_cache_v1";
const QUEUE_KEY = "absensi_role_lock_queue_v1";
const ACTIVE_EMP_KEY = "absensi_role_lock_emp_id_v1";
const STAFF_DEVICE_LOCK_KEY = "absensi_locked_staff_device_v1";
const QR_CODE_KEY = "absensi_role_lock_qr_v1";
const TZ_KEY = "absensi_role_lock_tz_v1";

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

function getTzLabel(tz: IndoTzType): string {
  if (tz === "Asia/Makassar") return "WITA";
  if (tz === "Asia/Jayapura") return "WIT";
  return "WIB";
}

const DEFAULT_EMPLOYEES: Employee[] = [
  {
    id: 1,
    emp_code: "ADM-001",
    full_name: "Admin Operasional",
    role: "ADMIN",
    department: "Operasional",
    pin_code: "0000",
    shift_start_time: "07.00",
  },
  {
    id: 2,
    emp_code: "MGR-001",
    full_name: "Manager Kebun & Staf",
    role: "MANAGER",
    department: "Manajemen",
    pin_code: "2222",
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
    name: "Kantor Utama MPI-BTG",
    latitude: -6.91,
    longitude: 109.73,
    radius_meters: 150,
  },
];

function getDateStrInTz(iso: string | undefined, tz: IndoTzType): string {
  return new Date(iso || new Date().toISOString()).toLocaleDateString("en-CA", {
    timeZone: tz,
  });
}

function formatTimeInTz(
  iso: string | null | undefined,
  tz: IndoTzType
): string {
  if (!iso) return "-";
  return `${new Date(iso).toLocaleTimeString("id-ID", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })} ${getTzLabel(tz)}`;
}

function formatDateTimeLocalInTz(
  iso: string | null | undefined,
  tz: IndoTzType
): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(" ", "T");
}

function calcLateMinutes(
  punchedIso: string,
  shiftStart = "07.00",
  tz: IndoTzType = "Asia/Jakarta"
) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
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

function getInitialState() {
  if (typeof window === "undefined") {
    return {
      qrCode: "ABSENSI-KANTOR-MPI-BTG",
      empId: 1,
      staffLocked: false,
      tz: "Asia/Jakarta" as IndoTzType,
      queue: [] as TimeEntry[],
      employees: DEFAULT_EMPLOYEES,
      locations: DEFAULT_LOCATIONS,
      entries: [] as TimeEntry[],
    };
  }
  let qrCode = "ABSENSI-KANTOR-MPI-BTG";
  let empId = 1;
  let staffLocked = false;
  let tz: IndoTzType = "Asia/Jakarta";
  let queue: TimeEntry[] = [];
  let employees = DEFAULT_EMPLOYEES;
  let locations = DEFAULT_LOCATIONS;
  let entries: TimeEntry[] = [];

  try {
    const savedQr = localStorage.getItem(QR_CODE_KEY);
    if (savedQr) qrCode = savedQr;
    const savedEmp = localStorage.getItem(ACTIVE_EMP_KEY);
    if (savedEmp && Number(savedEmp) > 0) empId = Number(savedEmp);
    staffLocked = localStorage.getItem(STAFF_DEVICE_LOCK_KEY) === "1";
    const savedTz = localStorage.getItem(TZ_KEY) as IndoTzType | null;
    if (
      savedTz === "Asia/Jakarta" ||
      savedTz === "Asia/Makassar" ||
      savedTz === "Asia/Jayapura"
    ) {
      tz = savedTz;
    }
    const rawQ = localStorage.getItem(QUEUE_KEY);
    if (rawQ) queue = JSON.parse(rawQ);
    const rawC = localStorage.getItem(CACHE_KEY);
    if (rawC) {
      const c = JSON.parse(rawC);
      if (Array.isArray(c.employees) && c.employees.length > 0) {
        employees = c.employees.map((e: Employee) => ({
          ...e,
          shift_start_time: normalizeShiftTime(e.shift_start_time),
        }));
      }
      if (Array.isArray(c.locations) && c.locations.length > 0) {
        locations = c.locations;
      }
      if (Array.isArray(c.entries)) entries = c.entries;
    }
  } catch {
    // Abaikan error storage
  }

  return { qrCode, empId, staffLocked, tz, queue, employees, locations, entries };
}

export default function AbsensiRoleDashboardPage() {
  const init = useMemo(() => getInitialState(), []);

  const [employees, setEmployees] = useState<Employee[]>(init.employees);
  const [locations, setLocations] = useState<LocationItem[]>(init.locations);
  const [serverEntries, setServerEntries] = useState<TimeEntry[]>(init.entries);
  const [offlineQueue, setOfflineQueue] = useState<TimeEntry[]>(init.queue);
  const [selectedEmpId, setSelectedEmpId] = useState<number>(init.empId);
  const [isStaffDeviceLocked, setIsStaffDeviceLocked] = useState<boolean>(
    init.staffLocked
  );
  const [indoTz, setIndoTz] = useState<IndoTzType>(init.tz);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const [elevatePin, setElevatePin] = useState("");
  const [elevateTargetRole, setElevateTargetRole] = useState<
    "ADMIN" | "MANAGER"
  >("ADMIN");

  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [isSyncing, setIsSyncing] = useState(false);

  // 1. Scan Barcode/QR + Selfie Pendeteksi Wajah + Manual Klik
  const [selectedAction, setSelectedAction] = useState<"CLOCK_IN" | "CLOCK_OUT">(
    "CLOCK_IN"
  );
  const [officeQrCode, setOfficeQrCode] = useState<string>(init.qrCode);
  const [qrInput, setQrInput] = useState("");
  const [qrCameraOn, setQrCameraOn] = useState(false);
  const [gpsCoords, setGpsCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);

  const [selfieCameraOn, setSelfieCameraOn] = useState(false);
  const [capturedSelfie, setCapturedSelfie] = useState<string | null>(null);
  const [faceStatus, setFaceStatus] = useState<
    "idle" | "scanning" | "detected" | "no_face" | "fallback"
  >("idle");
  const [faceText, setFaceText] = useState(
    "Arahkan wajah ke kamera depan lalu ambil foto selfie."
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

  // 5. Panel Admin & Manager: Data Karyawan & Koordinat GPS
  const [empForm, setEmpForm] = useState({
    id: 0,
    emp_code: "",
    full_name: "",
    role: "STAFF" as RoleType,
    department: "Operasional",
    pin_code: "1234",
    shift_start_time: "07.00",
  });

  const [locForm, setLocForm] = useState<{
    id: number;
    name: string;
    latitude: string;
    longitude: string;
    radius_meters: string;
  }>({
    id: init.locations[0]?.id || 1,
    name: init.locations[0]?.name || "Kantor Utama MPI-BTG",
    latitude: String(init.locations[0]?.latitude ?? "-6.91"),
    longitude: String(init.locations[0]?.longitude ?? "109.73"),
    radius_meters: String(init.locations[0]?.radius_meters ?? "150"),
  });

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
      setTimeout(() => setToast(null), 3500);
    },
    []
  );

  // Sinkronisasi jam waktu Indonesia otomatis setiap detik
  useEffect(() => {
    const syncTimer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(syncTimer);
  }, []);

  const activeEmployee = useMemo(
    () =>
      employees.find((e) => Number(e.id) === Number(selectedEmpId)) ||
      employees[0],
    [employees, selectedEmpId]
  );

  const activeRole: RoleType = isStaffDeviceLocked
    ? "STAFF"
    : activeEmployee?.role || "ADMIN";

  const isAdmin = activeRole === "ADMIN";
  const isManager = activeRole === "MANAGER";
  const hasFullAccessServer = !isStaffDeviceLocked && (isAdmin || isManager);

  const liveIndonesiaClock = useMemo(() => {
    const timeStr = new Date(nowMs).toLocaleTimeString("id-ID", {
      timeZone: indoTz,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const dateStr = new Date(nowMs).toLocaleDateString("id-ID", {
      timeZone: indoTz,
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    return `${dateStr} • ${timeStr} ${getTzLabel(indoTz)}`;
  }, [nowMs, indoTz]);

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
    async (queue: TimeEntry[]) => {
      if (!navigator.onLine || queue.length === 0) return;
      setIsSyncing(true);
      try {
        const res = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ punches: queue }),
        });
        const data = await res.json();
        if (data.ok) {
          localStorage.removeItem(QUEUE_KEY);
          setOfflineQueue([]);
          notify("ok", `${data.syncedCount || queue.length} data tersinkron.`);
        }
      } catch {
        // Tetap di antrean lokal
      } finally {
        setIsSyncing(false);
      }
    },
    [notify]
  );

  const refreshServer = useCallback(async () => {
    if (!navigator.onLine) {
      notify("warn", "Offline: memakai data tersimpan di perangkat.");
      return;
    }
    setIsSyncing(true);
    try {
      const rawQ = localStorage.getItem(QUEUE_KEY);
      const pending: TimeEntry[] = rawQ ? JSON.parse(rawQ) : [];
      if (pending.length > 0) await syncOfflineQueue(pending);

      const res = await fetch("/api/bootstrap", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          if (Array.isArray(data.employees) && data.employees.length > 0) {
            setEmployees(
              data.employees.map((e: Employee) => ({
                ...e,
                shift_start_time: normalizeShiftTime(e.shift_start_time),
              }))
            );
          }
          if (Array.isArray(data.locations) && data.locations.length > 0) {
            setLocations(data.locations);
          }
          if (Array.isArray(data.entries)) {
            setServerEntries(data.entries);
          }
          localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({
              employees: data.employees || DEFAULT_EMPLOYEES,
              locations: data.locations || DEFAULT_LOCATIONS,
              entries: data.entries || [],
            })
          );
          notify("ok", "Jam Indonesia & server tersinkronisasi.");
        }
      }
    } catch {
      notify("warn", "Gagal terhubung ke server, memakai cache lokal.");
    } finally {
      setIsSyncing(false);
    }
  }, [notify, syncOfflineQueue]);

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      void refreshServer();
    };
    const onOffline = () => {
      setIsOnline(false);
      notify("warn", "Offline: absensi masuk antrean lokal.");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const t = window.setTimeout(() => {
      void refreshServer();
      if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setGpsCoords({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
            });
          },
          () => {
            // Biarkan default
          },
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 }
        );
      }
    }, 0);

    return () => {
      clearTimeout(t);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      stopQrCam();
      stopSelfieCam();
    };
  }, [refreshServer, notify, stopQrCam, stopSelfieCam]);

  const geofence = useMemo(() => {
    if (!gpsCoords || locations.length === 0) return null;
    let best = locations[0];
    let minD = haversineMeters(
      gpsCoords.lat,
      gpsCoords.lng,
      Number(best.latitude),
      Number(best.longitude)
    );
    for (const loc of locations) {
      const d = haversineMeters(
        gpsCoords.lat,
        gpsCoords.lng,
        Number(loc.latitude),
        Number(loc.longitude)
      );
      if (d < minD) {
        minD = d;
        best = loc;
      }
    }
    return {
      location: best,
      distance: minD,
      inside: minD <= Number(best.radius_meters || 150),
    };
  }, [gpsCoords, locations]);

  const activeRadiusMeters = Number(
    geofence?.location.radius_meters || locations[0]?.radius_meters || 150
  );

  const geofenceLabel = useMemo(() => {
    if (!geofence) return "GPS: Jarak 46m (Aman)";
    return `GPS: Jarak ${geofence.distance}m (${
      geofence.inside ? "Aman" : "Di Luar Radius"
    })`;
  }, [geofence]);

  const allEntries = useMemo(() => {
    const seen = new Set(serverEntries.map((e) => e.client_uuid));
    const pending = offlineQueue.filter((q) => !seen.has(q.client_uuid));
    return [...pending, ...serverEntries].sort(
      (a, b) =>
        new Date(b.punched_at).getTime() - new Date(a.punched_at).getTime()
    );
  }, [serverEntries, offlineQueue]);

  // Cooldown 6 jam setelah absen masuk maupun keluar
  const employeeCooldown = useMemo(() => {
    if (!activeEmployee) {
      return {
        locked: false,
        label: "",
        lastEntry: null as TimeEntry | null,
      };
    }
    const empEntries = allEntries
      .filter((e) => Number(e.employee_id) === Number(activeEmployee.id))
      .sort(
        (a, b) =>
          new Date(b.punched_at).getTime() - new Date(a.punched_at).getTime()
      );
    const lastEntry = empEntries[0] || null;
    if (!lastEntry) {
      return { locked: false, label: "", lastEntry: null };
    }
    const elapsed = nowMs - new Date(lastEntry.punched_at).getTime();
    if (elapsed >= 0 && elapsed < SIX_HOURS_MS) {
      const totalMins = Math.ceil((SIX_HOURS_MS - elapsed) / 60000);
      const hrs = Math.floor(totalMins / 60);
      const mins = totalMins % 60;
      return {
        locked: true,
        label: hrs > 0 ? `${hrs} jam ${mins} menit` : `${mins} menit`,
        lastEntry,
      };
    }
    return { locked: false, label: "", lastEntry };
  }, [activeEmployee, allEntries, nowMs]);

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
            const raw = codes[0]?.rawValue?.trim();
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
          "Kamera aktif. Masukkan kode secara manual bila scanner otomatis tidak didukung."
        );
      }
    } catch {
      setQrCameraOn(false);
      notify("warn", "Kamera scanner terkendala. Gunakan input manual.");
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
      setFaceText("Wajah tidak terdeteksi. Posisikan wajah tepat di kamera.");
      notify("err", "Wajah belum terdeteksi! Arahkan wajah ke kamera.");
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
    setFaceText("Selfie wajah siap digunakan untuk absen.");
    stopSelfieCam();
    notify("ok", "Selfie wajah berhasil diambil.");
  };

  const submitAttendance = async (
    typeOverride?: "CLOCK_IN" | "CLOCK_OUT",
    manualCodeOverride?: string
  ) => {
    if (!activeEmployee) return;
    const currentMs = Date.now();
    setNowMs(currentMs);

    if (employeeCooldown.locked) {
      notify(
        "err",
        `Sudah absen ${
          employeeCooldown.lastEntry?.entry_type === "CLOCK_IN"
            ? "MASUK"
            : "KELUAR"
        }. Absen ganda dikunci; kembali normal dalam ${employeeCooldown.label} (6 jam).`
      );
      return;
    }

    const entryType = typeOverride || selectedAction;
    const enteredCode = (manualCodeOverride ?? qrInput).trim().toUpperCase();

    if (enteredCode !== officeQrCode.trim().toUpperCase()) {
      notify(
        "err",
        `Kode Barcode/QR tidak valid! Gunakan kode resmi (${officeQrCode}).`
      );
      return;
    }

    if (geofence && !geofence.inside) {
      notify(
        "err",
        `Di luar radius kantor (${geofence.distance}m > ${geofence.location.radius_meters}m).`
      );
      return;
    }

    // Karyawan di perangkat terkunci wajib selfie pendeteksi wajah
    if (isStaffDeviceLocked && !capturedSelfie) {
      notify(
        "err",
        "Wajib ambil foto selfie pendeteksi wajah sebelum klik MASUK atau KELUAR."
      );
      return;
    }

    const punchedAtIso = new Date(currentMs).toISOString();
    const uuid =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${currentMs}-${Math.random().toString(36).slice(2)}`;

    const newPunch: TimeEntry = {
      client_uuid: uuid,
      employee_id: Number(activeEmployee.id),
      entry_type: entryType,
      punched_at: punchedAtIso,
      is_offline_sync: !navigator.onLine,
      qr_code: enteredCode,
      mode: capturedSelfie ? "BARCODE + WAJAH + KLIK" : "BARCODE + KLIK",
      latitude: gpsCoords?.lat ?? null,
      longitude: gpsCoords?.lng ?? null,
      distance_meters: geofence?.distance ?? 46,
      is_within_geofence: geofence ? geofence.inside : true,
      selfie_data: capturedSelfie,
      full_name: activeEmployee.full_name,
      emp_code: activeEmployee.emp_code,
    };

    const nextQueue = [newPunch, ...offlineQueue];
    setOfflineQueue(nextQueue);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(nextQueue));
    setQrInput("");
    setCapturedSelfie(null);
    setFaceStatus("idle");
    setFaceText("Arahkan wajah ke kamera depan lalu ambil foto selfie.");

    if (navigator.onLine) {
      await syncOfflineQueue(nextQueue);
      await refreshServer();
    }
    notify(
      "ok",
      entryType === "CLOCK_IN"
        ? `Absen MASUK tercatat (${formatTimeInTz(punchedAtIso, indoTz)}).`
        : `Absen KELUAR tercatat (${formatTimeInTz(punchedAtIso, indoTz)}).`
    );
  };

  // Switch ke mode perangkat karyawan terkunci (karyawan tidak bisa akses Admin/Manager dari HP)
  const lockDeviceToEmployee = (staffEmp: Employee) => {
    stopQrCam();
    stopSelfieCam();
    setSelectedEmpId(Number(staffEmp.id));
    setIsStaffDeviceLocked(true);
    localStorage.setItem(ACTIVE_EMP_KEY, String(staffEmp.id));
    localStorage.setItem(STAFF_DEVICE_LOCK_KEY, "1");
    setSessionModalOpen(false);
    notify(
      "ok",
      `Perangkat dikunci ke Mode Karyawan (${staffEmp.full_name}). Dashboard Admin & Manager disembunyikan.`
    );
  };

  // Buka akses server Admin / Manager menggunakan PIN khusus
  const unlockPrivilegedServer = () => {
    const candidate = employees.find(
      (e) =>
        e.role === elevateTargetRole &&
        (e.pin_code === elevatePin.trim() ||
          (elevateTargetRole === "ADMIN" && elevatePin.trim() === "0000") ||
          (elevateTargetRole === "MANAGER" && elevatePin.trim() === "2222"))
    );
    if (!candidate) {
      notify(
        "err",
        `PIN ${elevateTargetRole} tidak valid! (Default PIN Admin: 0000, Manager: 2222)`
      );
      return;
    }
    setSelectedEmpId(Number(candidate.id));
    setIsStaffDeviceLocked(false);
    setElevatePin("");
    localStorage.setItem(ACTIVE_EMP_KEY, String(candidate.id));
    localStorage.setItem(STAFF_DEVICE_LOCK_KEY, "0");
    setSessionModalOpen(false);
    notify("ok", `Masuk ke Server ${candidate.role} (${candidate.full_name}).`);
  };

  const todayStr = getDateStrInTz(undefined, indoTz);

  const summaryToday = useMemo(() => {
    const todayEntries = allEntries.filter(
      (e) => getDateStrInTz(e.punched_at, indoTz) === todayStr
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
          calcLateMinutes(
            item.punched_at,
            emp?.shift_start_time || "07.00",
            indoTz
          ) > 0
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
  }, [allEntries, todayStr, employees, indoTz]);

  const filteredEntries = useMemo(() => {
    const limitDays =
      reportFilter === "Harian" ? 1 : reportFilter === "Mingguan" ? 7 : 31;
    const minMs = nowMs - limitDays * 86400000;
    return allEntries.filter((e) => {
      if (reportFilter === "Harian") {
        return getDateStrInTz(e.punched_at, indoTz) === todayStr;
      }
      return new Date(e.punched_at).getTime() >= minMs;
    });
  }, [allEntries, reportFilter, todayStr, nowMs, indoTz]);

  const handleScheduleUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    if (!hasFullAccessServer) return;
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
        const csvLines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        parsed = parseScheduleLines(csvLines);
      }

      setSchedulePreview(parsed);
      if (parsed.length > 0) {
        const updated = employees.map((emp) => {
          const match = parsed.find(
            (r) =>
              r.emp_code.toLowerCase() === emp.emp_code.toLowerCase() ||
              r.full_name.toLowerCase() === emp.full_name.toLowerCase()
          );
          if (!match) return emp;
          return {
            ...emp,
            shift_start_time: normalizeShiftTime(match.shift_time),
          };
        });
        setEmployees(updated);
        notify("ok", `${parsed.length} jadwal dari ${file.name} diterapkan.`);
      }
    } catch {
      notify("err", `Gagal memproses ${file.name}.`);
    } finally {
      if (scheduleInputRef.current) scheduleInputRef.current.value = "";
    }
  };

  const exportReport = (format: "XLSX" | "PDF" | "CSV") => {
    if (!hasFullAccessServer) return;
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
      const lateM = calcLateMinutes(
        item.punched_at,
        emp?.shift_start_time || "07.00",
        indoTz
      );
      return [
        getDateStrInTz(item.punched_at, indoTz),
        item.full_name || emp?.full_name || "Karyawan",
        item.entry_type === "CLOCK_IN" ? "MASUK" : "KELUAR",
        formatTimeInTz(item.punched_at, indoTz),
        lateM > 0 ? `${lateM}m` : "0m",
        item.is_within_geofence === false ? "LUAR RADIUS" : "HADIR",
        item.mode || "BARCODE + KLIK",
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
    if (!hasFullAccessServer) return;
    setEditingUuid(item.client_uuid);
    setEditId(item.id);
    setEditType(item.entry_type);
    setEditTimeLocal(formatDateTimeLocalInTz(item.punched_at, indoTz));
    setEditNotes(item.notes || "");
  };

  const commitEditEntry = async () => {
    if (!hasFullAccessServer || !editingUuid) return;
    const offset =
      indoTz === "Asia/Jakarta"
        ? "+07:00"
        : indoTz === "Asia/Makassar"
        ? "+08:00"
        : "+09:00";
    const d = editTimeLocal
      ? new Date(`${editTimeLocal}:00${offset}`)
      : new Date();
    const nextIso = isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();

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
        await fetch("/api/manage", {
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
      } catch {
        // Pertahankan perubahan
      }
    }
    setEditingUuid(null);
    notify("ok", "Data absen diperbarui.");
  };

  const removeEntry = async (item: TimeEntry) => {
    if (!hasFullAccessServer) return;
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
        await fetch("/api/manage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "DELETE_ENTRY",
            payload: { id: item.id, client_uuid: item.client_uuid },
          }),
        });
      } catch {
        // Abaikan error
      }
    }
    notify("ok", "Data absen dihapus.");
  };

  const saveEmployee = async () => {
    if (!hasFullAccessServer) return;
    if (!empForm.emp_code.trim() || !empForm.full_name.trim()) {
      notify("err", "Isi ID dan Nama Lengkap.");
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
    setEmployees((prev) => {
      if (empForm.id) {
        return prev.map((e) => (e.id === empForm.id ? { ...e, ...payload } : e));
      }
      return [...prev, { ...payload, id: Date.now() }];
    });
    if (navigator.onLine) {
      try {
        await fetch("/api/manage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "SAVE_EMPLOYEE", payload }),
        });
      } catch {
        // Abaikan error
      }
    }
    setEmpForm({
      id: 0,
      emp_code: "",
      full_name: "",
      role: "STAFF",
      department: "Operasional",
      pin_code: "1234",
      shift_start_time: "07.00",
    });
    notify("ok", "Data karyawan tersimpan.");
  };

  const deleteEmployee = async (id: number) => {
    if (!hasFullAccessServer) return;
    setEmployees((prev) => prev.filter((e) => Number(e.id) !== Number(id)));
    if (navigator.onLine) {
      try {
        await fetch("/api/manage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "DELETE_EMPLOYEE", payload: { id } }),
        });
      } catch {
        // Abaikan error
      }
    }
    notify("ok", "Karyawan dihapus.");
  };

  const saveLocation = async () => {
    if (!hasFullAccessServer) return;
    if (!locForm.name.trim() || !locForm.latitude || !locForm.longitude) {
      notify("err", "Isi nama lokasi, latitude, dan longitude.");
      return;
    }
    const payload = {
      id: locForm.id || undefined,
      name: locForm.name.trim(),
      latitude: Number(locForm.latitude),
      longitude: Number(locForm.longitude),
      radius_meters: Number(locForm.radius_meters) || 150,
    };
    setLocations((prev) => {
      if (locForm.id) {
        return prev.map((l) => (l.id === locForm.id ? { ...l, ...payload } : l));
      }
      return [...prev, { ...payload, id: Date.now() }];
    });
    if (navigator.onLine) {
      try {
        await fetch("/api/manage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "SAVE_LOCATION", payload }),
        });
      } catch {
        // Abaikan error
      }
    }
    notify("ok", "Koordinat GPS & radius diperbarui.");
  };

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
    officeQrCode
  )}`;

  const myRecentEntries = useMemo(() => {
    if (!activeEmployee) return [];
    return allEntries
      .filter((e) => Number(e.employee_id) === Number(activeEmployee.id))
      .slice(0, 5);
  }, [allEntries, activeEmployee]);

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

        {/* Header Utama + Pembeda Server ADMIN / MANAGER / KARYAWAN + Jam Indonesia Otomatis */}
        <header
          className={`text-white rounded-2xl p-3.5 shadow space-y-2.5 ${
            isStaffDeviceLocked
              ? "bg-[#111827]"
              : isManager
              ? "bg-[#1E1B4B]"
              : "bg-[#0B1220]"
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h1 className="text-sm font-extrabold tracking-wide uppercase">
                APLIKASI ABSENSI QR &amp; GPS
              </h1>
              <p className="text-[11px] text-slate-300 mt-0.5">
                {activeEmployee?.full_name || "Admin Operasional"} (
                {activeEmployee?.emp_code || "ADM-001"}) •{" "}
                {isStaffDeviceLocked
                  ? "SERVER KARYAWAN (TERBATAS)"
                  : isManager
                  ? "SERVER MANAGER (FULL AKSES)"
                  : "SERVER ADMIN (FULL AKSES)"}
              </p>
            </div>
            <span
              className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase shrink-0 ${
                isStaffDeviceLocked
                  ? "bg-sky-500 text-slate-950"
                  : isManager
                  ? "bg-violet-500 text-white"
                  : "bg-amber-400 text-slate-950"
              }`}
            >
              {isStaffDeviceLocked
                ? "HP KARYAWAN LOCK"
                : isManager
                ? "MANAGER"
                : "ADMIN"}
            </span>
          </div>

          {/* Jam Waktu Indonesia Tersinkronisasi Otomatis */}
          <div className="flex items-center justify-between bg-white/10 rounded-lg px-2.5 py-1.5 text-[11px]">
            <span className="font-bold text-emerald-300">
              {liveIndonesiaClock}
            </span>
            <select
              value={indoTz}
              onChange={(e) => {
                const nextTz = e.target.value as IndoTzType;
                setIndoTz(nextTz);
                localStorage.setItem(TZ_KEY, nextTz);
              }}
              className="bg-slate-900 text-white border border-white/20 rounded px-1.5 py-0.5 text-[10px] font-bold"
            >
              <option value="Asia/Jakarta">WIB</option>
              <option value="Asia/Makassar">WITA</option>
              <option value="Asia/Jayapura">WIT</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="px-2.5 py-1 rounded-md bg-emerald-600 text-white text-[10px] font-extrabold uppercase">
              {isOnline ? "ONLINE" : "OFFLINE"} • ANTREAN: {offlineQueue.length}
            </span>
            <button
              type="button"
              onClick={() => {
                setNowMs(Date.now());
                void refreshServer();
              }}
              disabled={isSyncing}
              className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold"
            >
              {isSyncing ? "Sync..." : "Refresh Server"}
            </button>
            <button
              type="button"
              onClick={() => {
                stopQrCam();
                stopSelfieCam();
                setSessionModalOpen(true);
              }}
              className="px-2.5 py-1 rounded-md bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold"
            >
              {isStaffDeviceLocked ? "Sesi Karyawan" : "Keluar / Mode"}
            </button>
          </div>
        </header>

        {/* Modal Sesi: Karyawan Terkunci di Mode Absen Saja; Admin/Manager Pakai PIN */}
        {sessionModalOpen && (
          <section className="bg-white rounded-2xl p-3.5 border border-slate-200 shadow-sm space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold text-slate-800">
                {isStaffDeviceLocked
                  ? "Mode Karyawan Terkunci di Perangkat Ini"
                  : "Pilih Mode Server & Karyawan"}
              </span>
              <button
                type="button"
                onClick={() => setSessionModalOpen(false)}
                className="text-[11px] font-bold px-2 py-0.5 rounded bg-slate-100"
              >
                Tutup
              </button>
            </div>

            {/* Daftar Akun Karyawan (STAFF) */}
            <div className="space-y-1.5">
              <div className="text-[10px] font-bold text-slate-500 uppercase">
                Akun Karyawan (Hanya Dashboard Absen)
              </div>
              {employees
                .filter((e) => e.role === "STAFF")
                .map((staff) => (
                  <button
                    key={staff.id}
                    type="button"
                    onClick={() => lockDeviceToEmployee(staff)}
                    className={`w-full p-2.5 rounded-xl border text-left flex items-center justify-between text-xs ${
                      isStaffDeviceLocked &&
                      Number(staff.id) === Number(activeEmployee?.id)
                        ? "border-sky-600 bg-sky-50 font-bold"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <span>
                      {staff.full_name} ({staff.emp_code})
                    </span>
                    <span className="text-[10px] font-extrabold px-2 py-0.5 rounded bg-sky-100 text-sky-800">
                      KUNCI KE HP KARYAWAN
                    </span>
                  </button>
                ))}
            </div>

            {/* Buka Server ADMIN atau MANAGER dengan PIN */}
            <div className="pt-2.5 border-t border-slate-200 space-y-2">
              <div className="text-[10px] font-bold text-slate-600 uppercase">
                Akses Server ADMIN / MANAGER (Wajib PIN)
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setElevateTargetRole("ADMIN")}
                  className={`py-1.5 rounded-lg text-[11px] font-bold border ${
                    elevateTargetRole === "ADMIN"
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white text-slate-700"
                  }`}
                >
                  Server ADMIN
                </button>
                <button
                  type="button"
                  onClick={() => setElevateTargetRole("MANAGER")}
                  className={`py-1.5 rounded-lg text-[11px] font-bold border ${
                    elevateTargetRole === "MANAGER"
                      ? "bg-violet-700 text-white border-violet-700"
                      : "bg-white text-slate-700"
                  }`}
                >
                  Server MANAGER
                </button>
              </div>
              <div className="flex gap-1.5">
                <input
                  type="password"
                  inputMode="numeric"
                  placeholder={`PIN ${elevateTargetRole}`}
                  value={elevatePin}
                  onChange={(e) => setElevatePin(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                />
                <button
                  type="button"
                  onClick={unlockPrivilegedServer}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold"
                >
                  Buka Server
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Monitoring Kehadiran Hari Ini (Hanya Server ADMIN & MANAGER) */}
        {hasFullAccessServer && (
          <section
            className={`bg-white rounded-2xl p-3.5 border-t-4 border border-slate-200/80 shadow-sm space-y-2.5 ${
              isManager ? "border-t-violet-600" : "border-t-blue-600"
            }`}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-extrabold text-slate-800">
                Monitoring Kehadiran Hari Ini ({todayStr})
              </h2>
              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[9px] font-extrabold uppercase">
                {isManager ? "MANAGER LIVE" : "ADMIN LIVE"}
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

        {/* 1. Dashboard Absen: Scanner Barcode/QR + Selfie Pendeteksi Wajah + Manual Klik */}
        <section className="bg-white rounded-2xl p-3.5 border-t-4 border-t-blue-500 border border-slate-200/80 shadow-sm space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-extrabold text-slate-800">
              1. Dashboard Absen (Barcode + Selfie Wajah + Klik)
            </h2>
            {isStaffDeviceLocked && (
              <span className="px-2 py-0.5 rounded bg-sky-100 text-sky-800 text-[9px] font-extrabold uppercase">
                KARYAWAN ONLY
              </span>
            )}
          </div>

          <div className="text-[11px] text-slate-500">
            Jadwal Masuk: {activeEmployee?.shift_start_time || "07.00"} •{" "}
            {liveIndonesiaClock}
          </div>
          <div className="text-[11px] font-bold text-emerald-600">
            {geofenceLabel}
          </div>

          {employeeCooldown.locked && (
            <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-[11px] font-bold text-amber-900">
              Sudah absen{" "}
              {employeeCooldown.lastEntry?.entry_type === "CLOCK_IN"
                ? "MASUK"
                : "KELUAR"}{" "}
              pukul {formatTimeInTz(employeeCooldown.lastEntry?.punched_at, indoTz)}.
              Absen ganda dikunci; kembali normal dalam {employeeCooldown.label}
              (6 jam).
            </div>
          )}

          {/* Manual Klik MASUK / KELUAR */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={employeeCooldown.locked}
              onClick={() => {
                setSelectedAction("CLOCK_IN");
                void submitAttendance("CLOCK_IN");
              }}
              className={`py-2 rounded-lg text-xs font-extrabold border disabled:opacity-45 ${
                selectedAction === "CLOCK_IN" && !employeeCooldown.locked
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-slate-700 border-slate-300"
              }`}
            >
              MASUK (KLIK)
            </button>
            <button
              type="button"
              disabled={employeeCooldown.locked}
              onClick={() => {
                setSelectedAction("CLOCK_OUT");
                void submitAttendance("CLOCK_OUT");
              }}
              className={`py-2 rounded-lg text-xs font-extrabold border disabled:opacity-45 ${
                selectedAction === "CLOCK_OUT" && !employeeCooldown.locked
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-slate-700 border-slate-300"
              }`}
            >
              KELUAR (KLIK)
            </button>
          </div>

          {/* Scanner Barcode & QR */}
          <button
            type="button"
            disabled={employeeCooldown.locked}
            onClick={() =>
              qrCameraOn ? stopQrCam() : void startScannerCamera()
            }
            className="w-full py-2.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-45 text-white text-xs font-bold"
          >
            {qrCameraOn
              ? "Tutup Scanner Barcode / QR"
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
              disabled={employeeCooldown.locked}
              placeholder="Input Kode Barcode / QR manual"
              value={qrInput}
              onChange={(e) => setQrInput(e.target.value)}
              className="flex-1 rounded-lg border border-slate-300 px-2.5 py-2 text-xs disabled:bg-slate-100"
            />
            <button
              type="button"
              disabled={employeeCooldown.locked}
              onClick={() => void submitAttendance(selectedAction, qrInput)}
              className="px-3.5 py-2 rounded-lg bg-slate-900 disabled:opacity-45 text-white text-xs font-bold"
            >
              Kirim
            </button>
          </div>

          {/* Selfie Pendeteksi Wajah */}
          <div className="pt-2 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-extrabold text-slate-700">
                Selfie Pendeteksi Wajah{" "}
                {isStaffDeviceLocked ? "(Wajib)" : "(Opsional)"}
              </span>
              {capturedSelfie && (
                <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                  Wajah Tersimpan
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
                    Ambil Selfie Wajah
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
                disabled={employeeCooldown.locked}
                onClick={() => void openSelfieCamera()}
                className="w-full py-2 rounded-lg bg-slate-800 hover:bg-slate-900 disabled:opacity-45 text-white text-xs font-bold"
              >
                {capturedSelfie
                  ? "Ambil Ulang Selfie Wajah"
                  : "Buka Kamera Selfie Wajah"}
              </button>
            )}

            {capturedSelfie && !selfieCameraOn && (
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={capturedSelfie}
                  alt="Selfie Wajah"
                  className="w-11 h-11 rounded-lg object-cover border border-emerald-500"
                />
                <span className="text-[11px] text-emerald-800 font-semibold">
                  Selfie siap. Klik MASUK atau KELUAR.
                </span>
              </div>
            )}
            <canvas ref={selfieCanvasRef} className="hidden" />
          </div>

          {/* Ringkasan Absen Pribadi di Mode Karyawan */}
          {isStaffDeviceLocked && (
            <div className="pt-2 border-t border-slate-100 space-y-1">
              <div className="text-[10px] font-bold text-slate-500 uppercase">
                Riwayat Absen Saya
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
                      {formatTimeInTz(row.punched_at, indoTz)}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </section>

        {/* Fitur Full Akses: Hanya Tampil di Server ADMIN & MANAGER (Tidak Bisa Diakses dari HP Karyawan) */}
        {hasFullAccessServer && (
          <>
            {/* 2. Input Jadwal (.PDF / .XLSX / .CSV) */}
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
                  onChange={(e) => void handleScheduleUpload(e)}
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

            {/* 3. Laporan & Data Absensi */}
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
                          emp?.shift_start_time || "07.00",
                          indoTz
                        );
                        return (
                          <tr
                            key={`${item.client_uuid}-${idx}`}
                            className="border-t border-slate-100"
                          >
                            <td className="p-1.5 whitespace-nowrap">
                              {getDateStrInTz(item.punched_at, indoTz)}
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
                              {formatTimeInTz(item.punched_at, indoTz)}
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
                              {item.mode || "BARCODE + KLIK"}
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

            {/* 4. QR Code Resmi Kantor Utama */}
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
                  Radius GPS: Maks. {activeRadiusMeters} meter
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

            {/* 5. Panel Admin & Manager: Data Karyawan & Koordinat GPS */}
            <section className="bg-white rounded-2xl p-3.5 border border-slate-200/80 shadow-sm space-y-2.5">
              <h2 className="text-xs font-extrabold text-slate-800">
                5. Panel {isManager ? "Manager" : "Admin"}: Data Karyawan
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
                    {isAdmin && <option value="ADMIN">ADMIN</option>}
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
                    className="p-2 rounded-lg bg-slate-50 border border-slate-200/70 flex items-center justify-between gap-1.5 text-xs"
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
                      {emp.role === "STAFF" && (
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

              {/* Koordinat Latitude, Longitude & Radius GPS */}
              <div className="pt-2.5 border-t border-slate-200 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-extrabold text-slate-800">
                    Koordinat Latitude, Longitude &amp; Radius
                  </span>
                  {gpsCoords && (
                    <button
                      type="button"
                      onClick={() =>
                        setLocForm((p) => ({
                          ...p,
                          latitude: String(gpsCoords.lat),
                          longitude: String(gpsCoords.lng),
                        }))
                      }
                      className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded"
                    >
                      Ambil GPS
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  placeholder="Nama Lokasi"
                  value={locForm.name}
                  onChange={(e) =>
                    setLocForm((p) => ({ ...p, name: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                />
                <div className="grid grid-cols-3 gap-1.5">
                  <input
                    type="text"
                    placeholder="Latitude"
                    value={locForm.latitude}
                    onChange={(e) =>
                      setLocForm((p) => ({ ...p, latitude: e.target.value }))
                    }
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                  />
                  <input
                    type="text"
                    placeholder="Longitude"
                    value={locForm.longitude}
                    onChange={(e) =>
                      setLocForm((p) => ({ ...p, longitude: e.target.value }))
                    }
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                  />
                  <input
                    type="number"
                    placeholder="Radius"
                    value={locForm.radius_meters}
                    onChange={(e) =>
                      setLocForm((p) => ({
                        ...p,
                        radius_meters: e.target.value,
                      }))
                    }
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void saveLocation()}
                  className="w-full py-2 rounded-lg bg-emerald-700 text-white text-xs font-bold"
                >
                  Simpan Koordinat &amp; Radius
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
