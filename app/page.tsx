"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

type RoleType = "ADMIN" | "MANAGER" | "STAFF";

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

interface BarcodeDetectorInstance {
  detect: (video: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
}

const SHIFT_OPTIONS = [
  { label: "Shift Pagi (07.00)", time: "07.00" },
  { label: "Shift Siang (15.00)", time: "15.00" },
  { label: "Shift Malam (23.00)", time: "23.00" },
];

const CACHE_KEY = "absensi_admin_jibble_cache_v1";
const QUEUE_KEY = "absensi_admin_jibble_queue_v1";
const QR_CODE_KEY = "absensi_admin_jibble_qr_v1";
const ADMIN_PIN_KEY = "absensi_admin_jibble_unlocked_v1";

function normalizeShiftTime(raw?: string | null): string {
  const s = String(raw || "").trim();
  if (!s) return "07.00";
  if (s.includes("15:00") || s.includes("15.00") || s.toLowerCase().includes("siang"))
    return "15.00";
  if (s.includes("23:00") || s.includes("23.00") || s.toLowerCase().includes("malam"))
    return "23.00";
  if (s.includes("07:00") || s.includes("07.00") || s.toLowerCase().includes("pagi"))
    return "07.00";
  return s.replace(":", ".");
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

    const timeMatch = line.match(/\b(07[:.]00|15[:.]00|23[:.]00|[012]?\d[:.]\d{2})\b/);
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
    let cols = line.split(/[,;|]+/).map((c) => c.trim()).filter(Boolean);
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
        emp_code: empCode || `KRY-${String(parsed.length + 1).padStart(3, "0")}`,
        full_name: fullName || empCode,
        shift_time: shiftTime,
      });
    }
  }

  return parsed;
}

function getInitialAdminState() {
  if (typeof window === "undefined") {
    return {
      qrCode: "ABSENSI-KANTOR-MPI-BTG",
      queue: [] as TimeEntry[],
      employees: DEFAULT_EMPLOYEES,
      locations: DEFAULT_LOCATIONS,
      entries: [] as TimeEntry[],
    };
  }
  let qrCode = "ABSENSI-KANTOR-MPI-BTG";
  let queue: TimeEntry[] = [];
  let employees = DEFAULT_EMPLOYEES;
  let locations = DEFAULT_LOCATIONS;
  let entries: TimeEntry[] = [];

  try {
    const savedQr = localStorage.getItem(QR_CODE_KEY);
    if (savedQr) qrCode = savedQr;
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
    // Abaikan error localStorage
  }

  return { qrCode, queue, employees, locations, entries };
}

export default function AdminJibbleDashboardPage() {
  const init = useMemo(() => getInitialAdminState(), []);

  const [employees, setEmployees] = useState<Employee[]>(init.employees);
  const [locations, setLocations] = useState<LocationItem[]>(init.locations);
  const [serverEntries, setServerEntries] = useState<TimeEntry[]>(init.entries);
  const [offlineQueue, setOfflineQueue] = useState<TimeEntry[]>(init.queue);

  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [isSyncing, setIsSyncing] = useState(false);
  const [isLockedScreen, setIsLockedScreen] = useState(false);
  const [unlockPinInput, setUnlockPinInput] = useState("");

  // 1. Scan QR & GPS Realtime (Admin bisa absen sendiri atau input absen karyawan)
  const [targetPunchEmpId, setTargetPunchEmpId] = useState<number>(1);
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

  // 2. Input Jadwal PDF / XLSX / CSV
  const [scheduleFileName, setScheduleFileName] = useState(
    "Tidak ada file yang dipilih"
  );
  const [schedulePreview, setSchedulePreview] = useState<
    Array<{ emp_code: string; full_name: string; shift_time: string }>
  >([]);

  // 3. Laporan & Data Absensi (Filter, Download XLSX/PDF/CSV, Edit Waktu/Jenis/Catatan, Hapus)
  const [reportFilter, setReportFilter] = useState<
    "Harian" | "Mingguan" | "Bulanan"
  >("Harian");
  const [empFilterId, setEmpFilterId] = useState<string>("ALL");
  const [editingUuid, setEditingUuid] = useState<string | null>(null);
  const [editId, setEditId] = useState<number | undefined>(undefined);
  const [editEmpId, setEditEmpId] = useState<number>(1);
  const [editType, setEditType] = useState<"CLOCK_IN" | "CLOCK_OUT">(
    "CLOCK_IN"
  );
  const [editTimeLocal, setEditTimeLocal] = useState("");
  const [editNotes, setEditNotes] = useState("");

  // 5. Panel Admin: Data Karyawan & Titik Koordinat Latitude / Longitude / Radius
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
  const scheduleInputRef = useRef<HTMLInputElement | null>(null);

  const notify = useCallback(
    (type: "ok" | "warn" | "err", text: string) => {
      setToast({ type, text });
      setTimeout(() => setToast(null), 3500);
    },
    []
  );

  const adminAccount = useMemo(
    () =>
      employees.find((e) => e.role === "ADMIN" || e.role === "MANAGER") ||
      employees[0] ||
      DEFAULT_EMPLOYEES[0],
    [employees]
  );

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
      notify("warn", "Offline: menampilkan data lokal.");
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
            const first = data.locations[0];
            setLocForm((prev) =>
              prev.latitude
                ? prev
                : {
                    id: first.id,
                    name: first.name,
                    latitude: String(first.latitude),
                    longitude: String(first.longitude),
                    radius_meters: String(first.radius_meters),
                  }
            );
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
          notify("ok", "Data server administrator diperbarui.");
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
      notify("warn", "Koneksi offline: perubahan masuk antrean.");
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
    };
  }, [refreshServer, notify, stopQrCam]);

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

  const startQrCamera = async () => {
    try {
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
        const detector = new BD({ formats: ["qr_code"] });
        const step = async () => {
          if (!qrVideoRef.current || !qrVideoRef.current.srcObject) return;
          try {
            const codes = await detector.detect(qrVideoRef.current);
            const raw = codes[0]?.rawValue?.trim();
            if (raw) {
              setQrInput(raw);
              stopQrCam();
              notify("ok", `QR terbaca: ${raw}`);
              return;
            }
          } catch {
            // Lanjutkan scan
          }
          qrRafRef.current = requestAnimationFrame(step);
        };
        qrRafRef.current = requestAnimationFrame(step);
      }
    } catch {
      setQrCameraOn(false);
      notify("warn", "Kamera terkendala. Gunakan input kode QR manual.");
    }
  };

  const submitAdminPunch = async (
    typeOverride?: "CLOCK_IN" | "CLOCK_OUT",
    manualCodeOverride?: string
  ) => {
    const targetEmp =
      employees.find((e) => Number(e.id) === Number(targetPunchEmpId)) ||
      adminAccount;
    const entryType = typeOverride || selectedAction;
    const enteredQr = (manualCodeOverride ?? qrInput).trim().toUpperCase();

    if (enteredQr && enteredQr !== officeQrCode.trim().toUpperCase()) {
      notify(
        "err",
        `QR tidak cocok! Gunakan QR resmi (${officeQrCode}).`
      );
      return;
    }

    const uuid =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const newPunch: TimeEntry = {
      client_uuid: uuid,
      employee_id: Number(targetEmp.id),
      entry_type: entryType,
      punched_at: new Date().toISOString(),
      is_offline_sync: !navigator.onLine,
      qr_code: enteredQr || officeQrCode,
      mode: enteredQr ? "QR + GPS" : "ADMIN OVERRIDE",
      latitude: gpsCoords?.lat ?? Number(locations[0]?.latitude ?? -6.91),
      longitude: gpsCoords?.lng ?? Number(locations[0]?.longitude ?? 109.73),
      distance_meters: geofence?.distance ?? 0,
      is_within_geofence: true,
      full_name: targetEmp.full_name,
      emp_code: targetEmp.emp_code,
    };

    const nextQueue = [newPunch, ...offlineQueue];
    setOfflineQueue(nextQueue);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(nextQueue));
    setQrInput("");

    if (navigator.onLine) {
      await syncOfflineQueue(nextQueue);
      await refreshServer();
    }
    notify(
      "ok",
      `${entryType === "CLOCK_IN" ? "MASUK" : "KELUAR"} dicatat untuk ${
        targetEmp.full_name
      }.`
    );
  };

  const allEntries = useMemo(() => {
    const seen = new Set(serverEntries.map((e) => e.client_uuid));
    const pending = offlineQueue.filter((q) => !seen.has(q.client_uuid));
    return [...pending, ...serverEntries].sort(
      (a, b) =>
        new Date(b.punched_at).getTime() - new Date(a.punched_at).getTime()
    );
  }, [serverEntries, offlineQueue]);

  const todayStr = getJakartaDateStr();

  // Monitoring Kehadiran Hari Ini + Live Status ala Jibble (Sedang Kerja, Terlambat, Keluar, Belum Absen)
  const jibbleLiveStatus = useMemo(() => {
    const todayEntries = allEntries.filter(
      (e) => getJakartaDateStr(e.punched_at) === todayStr
    );
    const inSet = new Set<number>();
    const outSet = new Set<number>();
    let lateCount = 0;

    const perEmployee = employees.map((emp) => {
      const logs = todayEntries
        .filter((e) => Number(e.employee_id) === Number(emp.id))
        .sort(
          (a, b) =>
            new Date(a.punched_at).getTime() - new Date(b.punched_at).getTime()
        );
      const firstIn = logs.find((l) => l.entry_type === "CLOCK_IN");
      const lastLog = logs[logs.length - 1];
      let status: "BEKERJA" | "PULANG" | "BELUM" = "BELUM";
      let lateMins = 0;
      let workMinutes = 0;

      if (firstIn) {
        inSet.add(Number(emp.id));
        lateMins = calcLateMinutes(
          firstIn.punched_at,
          emp.shift_start_time || "07.00"
        );
        if (lateMins > 0) lateCount++;
      }

      if (lastLog) {
        if (lastLog.entry_type === "CLOCK_IN") {
          status = "BEKERJA";
        } else {
          status = "PULANG";
          outSet.add(Number(emp.id));
        }
      }

      if (firstIn) {
        const endMs =
          lastLog && lastLog.entry_type === "CLOCK_OUT"
            ? new Date(lastLog.punched_at).getTime()
            : Date.now();
        workMinutes = Math.max(
          0,
          Math.round((endMs - new Date(firstIn.punched_at).getTime()) / 60000)
        );
      }

      return {
        emp,
        status,
        firstIn,
        lastLog,
        lateMins,
        workMinutes,
      };
    });

    return {
      masuk: inSet.size,
      terlambat: lateCount,
      keluar: outSet.size,
      perEmployee,
    };
  }, [allEntries, todayStr, employees]);

  const filteredEntries = useMemo(() => {
    const nowTimestamp = Date.now();
    const limitDays =
      reportFilter === "Harian" ? 1 : reportFilter === "Mingguan" ? 7 : 31;
    const minMs = nowTimestamp - limitDays * 86400000;
    return allEntries.filter((e) => {
      const matchEmp =
        empFilterId === "ALL" || Number(e.employee_id) === Number(empFilterId);
      if (!matchEmp) return false;
      if (reportFilter === "Harian") {
        return getJakartaDateStr(e.punched_at) === todayStr;
      }
      return new Date(e.punched_at).getTime() >= minMs;
    });
  }, [allEntries, reportFilter, todayStr, empFilterId]);

  // 2. Masukan Jadwal Karyawan Langsung dalam Bentuk PDF (atau XLSX / CSV)
  const handleScheduleUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
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
        const pdfLines = extractLinesFromPdfBytes(bytes);
        parsed = parseScheduleLines(pdfLines);
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
        const nextEmployees = employees.map((emp) => {
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
        setEmployees(nextEmployees);

        if (navigator.onLine) {
          for (const row of parsed) {
            const matched = nextEmployees.find(
              (emp) =>
                emp.emp_code.toLowerCase() === row.emp_code.toLowerCase() ||
                emp.full_name.toLowerCase() === row.full_name.toLowerCase()
            );
            if (matched) {
              try {
                await fetch("/api/manage", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    action: "SAVE_EMPLOYEE",
                    payload: matched,
                  }),
                });
              } catch {
                // Abaikan error per baris
              }
            }
          }
          await refreshServer();
        }
        notify("ok", `${parsed.length} jadwal karyawan berhasil dimuat dari ${file.name}.`);
      } else {
        notify(
          "warn",
          `File ${file.name} terbaca, namun tidak ditemukan baris jadwal yang cocok.`
        );
      }
    } catch {
      notify("err", `Gagal membaca file ${file.name}.`);
    } finally {
      if (scheduleInputRef.current) scheduleInputRef.current.value = "";
    }
  };

  // 3. Download Laporan XLSX / PDF / CSV
  const downloadReport = (format: "XLSX" | "PDF" | "CSV") => {
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
        item.mode || "QR + GPS",
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

  // Edit Waktu, Jenis & Karyawan Data Absen
  const openEditEntry = (item: TimeEntry) => {
    setEditingUuid(item.client_uuid);
    setEditId(item.id);
    setEditEmpId(Number(item.employee_id));
    setEditType(item.entry_type);
    setEditTimeLocal(formatDateTimeLocalWIB(item.punched_at));
    setEditNotes(item.notes || "");
  };

  const saveEditEntry = async () => {
    if (!editingUuid) return;
    const d = editTimeLocal
      ? new Date(`${editTimeLocal}:00+07:00`)
      : new Date();
    const nextIso = isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    const targetEmp = employees.find((e) => Number(e.id) === Number(editEmpId));

    setServerEntries((prev) =>
      prev.map((x) =>
        x.client_uuid === editingUuid
          ? {
              ...x,
              employee_id: editEmpId,
              full_name: targetEmp?.full_name || x.full_name,
              emp_code: targetEmp?.emp_code || x.emp_code,
              entry_type: editType,
              punched_at: nextIso,
              notes: editNotes,
            }
          : x
      )
    );
    setOfflineQueue((prev) => {
      const next = prev.map((x) =>
        x.client_uuid === editingUuid
          ? {
              ...x,
              employee_id: editEmpId,
              full_name: targetEmp?.full_name || x.full_name,
              emp_code: targetEmp?.emp_code || x.emp_code,
              entry_type: editType,
              punched_at: nextIso,
              notes: editNotes,
            }
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
              employee_id: editEmpId,
              entry_type: editType,
              punched_at: nextIso,
              notes: editNotes,
            },
          }),
        });
        await refreshServer();
      } catch {
        // Pertahankan perubahan state
      }
    }
    setEditingUuid(null);
    notify("ok", "Waktu dan data absen berhasil diperbarui.");
  };

  const deleteEntry = async (item: TimeEntry) => {
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
        await refreshServer();
      } catch {
        // Abaikan error jaringan
      }
    }
    notify("ok", "Catatan absen berhasil dihapus.");
  };

  // Simpan / Edit / Hapus Anggota Karyawan
  const saveEmployee = async () => {
    if (!empForm.emp_code.trim() || !empForm.full_name.trim()) {
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
        const res = await fetch("/api/manage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "SAVE_EMPLOYEE", payload }),
        });
        const data = await res.json();
        if (data.ok) {
          await refreshServer();
          setEmpForm({
            id: 0,
            emp_code: "",
            full_name: "",
            role: "STAFF",
            department: "Operasional",
            pin_code: "1234",
            shift_start_time: "07.00",
          });
          notify("ok", "Anggota karyawan berhasil disimpan.");
          return;
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
    notify("ok", "Anggota karyawan diperbarui.");
  };

  const deleteEmployee = async (emp: Employee) => {
    if (navigator.onLine) {
      try {
        await fetch("/api/manage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "DELETE_EMPLOYEE",
            payload: { id: emp.id },
          }),
        });
        await refreshServer();
      } catch {
        // Abaikan error
      }
    }
    setEmployees((prev) => prev.filter((e) => Number(e.id) !== Number(emp.id)));
    notify("ok", `Anggota karyawan ${emp.full_name} berhasil dihapus.`);
  };

  // Edit / Simpan / Hapus Koordinat Latitude, Longitude & Radius Kantor
  const saveLocationCoordinates = async () => {
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
    if (navigator.onLine) {
      try {
        const res = await fetch("/api/manage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "SAVE_LOCATION", payload }),
        });
        const data = await res.json();
        if (data.ok) {
          await refreshServer();
          notify("ok", "Koordinat Latitude/Longitude & Radius disimpan.");
          return;
        }
      } catch {
        // Fallback lokal
      }
    }
    setLocations((prev) => {
      if (locForm.id) {
        return prev.map((l) => (l.id === locForm.id ? { ...l, ...payload } : l));
      }
      return [...prev, { ...payload, id: Date.now() }];
    });
    notify("ok", "Koordinat GPS diperbarui.");
  };

  const deleteLocation = async (id: number) => {
    if (navigator.onLine) {
      try {
        await fetch("/api/manage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "DELETE_LOCATION", payload: { id } }),
        });
        await refreshServer();
      } catch {
        // Abaikan error
      }
    }
    setLocations((prev) => prev.filter((l) => l.id !== id));
    notify("ok", "Titik lokasi dihapus.");
  };

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
    officeQrCode
  )}`;

  if (isLockedScreen) {
    return (
      <div className="min-h-screen bg-[#ECEFF4] flex items-center justify-center p-4">
        <div className="max-w-sm w-full bg-white rounded-2xl p-5 shadow space-y-3 border border-slate-200">
          <div className="text-sm font-extrabold text-slate-900 uppercase">
            Server Administrator Terkunci
          </div>
          <p className="text-xs text-slate-500">
            Masukkan PIN Admin ({adminAccount.full_name}) untuk membuka kembali
            dashboard full akses.
          </p>
          <input
            type="password"
            inputMode="numeric"
            placeholder="PIN Admin (default: 0000)"
            value={unlockPinInput}
            onChange={(e) => setUnlockPinInput(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-center tracking-widest"
          />
          <button
            type="button"
            onClick={() => {
              if (
                unlockPinInput === adminAccount.pin_code ||
                unlockPinInput === "0000"
              ) {
                localStorage.setItem(ADMIN_PIN_KEY, "1");
                setIsLockedScreen(false);
                setUnlockPinInput("");
                notify("ok", "Akses Admin dibuka.");
              } else {
                notify("err", "PIN Admin salah.");
              }
            }}
            className="w-full py-2.5 rounded-lg bg-blue-600 text-white text-xs font-extrabold"
          >
            Masuk Server Admin
          </button>
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

        {/* Header Utama */}
        <header className="bg-[#0B1220] text-white rounded-2xl p-3.5 shadow space-y-2.5">
          <div>
            <h1 className="text-sm font-extrabold tracking-wide uppercase">
              APLIKASI ABSENSI QR &amp; GPS
            </h1>
            <p className="text-[11px] text-slate-300 mt-0.5">
              {adminAccount.full_name} ({adminAccount.emp_code}) • ADMIN
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="px-2.5 py-1 rounded-md bg-emerald-600 text-white text-[10px] font-extrabold uppercase">
              {isOnline ? "ONLINE" : "OFFLINE"} • ANTREAN: {offlineQueue.length}
            </span>
            <button
              type="button"
              onClick={() => void refreshServer()}
              disabled={isSyncing}
              className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold"
            >
              {isSyncing ? "Sync..." : "Refresh Server"}
            </button>
            <button
              type="button"
              onClick={() => {
                stopQrCam();
                setIsLockedScreen(true);
              }}
              className="px-2.5 py-1 rounded-md bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold"
            >
              Keluar
            </button>
          </div>
        </header>

        {/* Monitoring Kehadiran Hari Ini + Live Status Anggota (Gaya Jibble) */}
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
                {jibbleLiveStatus.masuk}
              </div>
              <div className="text-[10px] text-slate-500 font-medium">
                Absen Masuk
              </div>
            </div>
            <div className="p-2.5 rounded-xl bg-amber-50/80 border border-amber-100">
              <div className="text-base font-extrabold text-amber-600">
                {jibbleLiveStatus.terlambat}
              </div>
              <div className="text-[10px] text-slate-500 font-medium">
                Terlambat
              </div>
            </div>
            <div className="p-2.5 rounded-xl bg-emerald-50/80 border border-emerald-100">
              <div className="text-base font-extrabold text-emerald-700">
                {jibbleLiveStatus.keluar}
              </div>
              <div className="text-[10px] text-slate-500 font-medium">
                Absen Keluar
              </div>
            </div>
          </div>

          {/* Live Presence Board ala Jibble */}
          <div className="pt-1.5 border-t border-slate-100 space-y-1.5">
            <div className="text-[10px] font-extrabold text-slate-500 uppercase">
              Status Anggota Live (Jibble View)
            </div>
            {jibbleLiveStatus.perEmployee.map(
              ({ emp, status, firstIn, lateMins, workMinutes }) => {
                const hrs = Math.floor(workMinutes / 60);
                const mins = workMinutes % 60;
                return (
                  <div
                    key={emp.id}
                    className="flex items-center justify-between p-2 rounded-xl bg-slate-50 border border-slate-200/60 text-[11px]"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                          status === "BEKERJA"
                            ? "bg-emerald-500"
                            : status === "PULANG"
                            ? "bg-blue-500"
                            : "bg-slate-300"
                        }`}
                      />
                      <div className="truncate">
                        <div className="font-bold text-slate-800 truncate">
                          {emp.full_name}{" "}
                          <span className="text-[10px] font-normal text-slate-500">
                            ({emp.emp_code})
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-500">
                          Shift {emp.shift_start_time || "07.00"}
                          {firstIn
                            ? ` • Masuk ${formatTimeWIB(firstIn.punched_at)}`
                            : ""}
                          {lateMins > 0 ? ` • Telat ${lateMins}m` : ""}
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[9px] font-extrabold ${
                          status === "BEKERJA"
                            ? "bg-emerald-100 text-emerald-700"
                            : status === "PULANG"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-slate-200 text-slate-600"
                        }`}
                      >
                        {status === "BEKERJA"
                          ? "BEKERJA"
                          : status === "PULANG"
                          ? "PULANG"
                          : "BELUM"}
                      </span>
                      {workMinutes > 0 && (
                        <div className="text-[9px] text-slate-500 mt-0.5">
                          {hrs}j {mins}m
                        </div>
                      )}
                    </div>
                  </div>
                );
              }
            )}
          </div>
        </section>

        {/* 1. Scan QR & GPS Realtime + Quick Punch Anggota */}
        <section className="bg-white rounded-2xl p-3.5 border-t-4 border-t-blue-500 border border-slate-200/80 shadow-sm space-y-2.5">
          <h2 className="text-xs font-extrabold text-slate-800">
            1. Scan QR &amp; GPS Realtime
          </h2>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">
              Jadwal Masuk: {adminAccount.shift_start_time || "07.00"}
            </span>
            <select
              value={targetPunchEmpId}
              onChange={(e) => setTargetPunchEmpId(Number(e.target.value))}
              className="rounded-lg border border-slate-300 px-2 py-1 text-[11px] font-bold bg-slate-50"
            >
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.full_name} ({emp.emp_code})
                </option>
              ))}
            </select>
          </div>
          <div className="text-[11px] font-bold text-emerald-600">
            {geofenceLabel}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setSelectedAction("CLOCK_IN");
                void submitAdminPunch("CLOCK_IN");
              }}
              className={`py-2 rounded-lg text-xs font-extrabold border ${
                selectedAction === "CLOCK_IN"
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-slate-700 border-slate-300"
              }`}
            >
              MASUK
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedAction("CLOCK_OUT");
                void submitAdminPunch("CLOCK_OUT");
              }}
              className={`py-2 rounded-lg text-xs font-extrabold border ${
                selectedAction === "CLOCK_OUT"
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-slate-700 border-slate-300"
              }`}
            >
              KELUAR
            </button>
          </div>

          <button
            type="button"
            onClick={() => (qrCameraOn ? stopQrCam() : void startQrCamera())}
            className="w-full py-2.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold"
          >
            {qrCameraOn ? "Tutup Kamera Scan QR" : "Buka Kamera Scan QR"}
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
              placeholder="Input Kode QR manual jika kamera terkendala"
              value={qrInput}
              onChange={(e) => setQrInput(e.target.value)}
              className="flex-1 rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
            />
            <button
              type="button"
              onClick={() => void submitAdminPunch(selectedAction, qrInput)}
              className="px-3.5 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold"
            >
              Kirim
            </button>
          </div>
        </section>

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
              {schedulePreview.map((row, idx) => (
                <div
                  key={`${row.emp_code}-${idx}`}
                  className="text-[10px] bg-emerald-50 text-emerald-900 px-2.5 py-1 rounded flex justify-between font-semibold"
                >
                  <span>
                    {row.full_name} ({row.emp_code})
                  </span>
                  <span>Shift {row.shift_time}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 3. Laporan & Data Absensi (Download, Edit Waktu/Jenis, Hapus Absen) */}
        <section className="bg-white rounded-2xl p-3.5 border border-slate-200/80 shadow-sm space-y-2.5">
          <div className="flex items-center justify-between gap-1.5">
            <h2 className="text-xs font-extrabold text-slate-800">
              3. Laporan &amp; Data Absensi:
            </h2>
            <div className="flex gap-1">
              <select
                value={empFilterId}
                onChange={(e) => setEmpFilterId(e.target.value)}
                className="rounded-lg border border-slate-300 px-1.5 py-1 text-[10px] font-semibold bg-white max-w-[100px]"
              >
                <option value="ALL">Semua Staf</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={String(emp.id)}>
                    {emp.full_name}
                  </option>
                ))}
              </select>
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
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => downloadReport("XLSX")}
              className="py-2 rounded-lg bg-emerald-700 text-white text-[11px] font-bold"
            >
              Download XLSX
            </button>
            <button
              type="button"
              onClick={() => downloadReport("PDF")}
              className="py-2 rounded-lg bg-rose-600 text-white text-[11px] font-bold"
            >
              Download PDF
            </button>
            <button
              type="button"
              onClick={() => downloadReport("CSV")}
              className="py-2 rounded-lg bg-slate-800 text-white text-[11px] font-bold"
            >
              Download CSV
            </button>
          </div>

          {editingUuid && (
            <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-300 space-y-2">
              <div className="text-[11px] font-extrabold text-amber-900">
                Edit Waktu &amp; Catatan Absensi
              </div>
              <select
                value={editEmpId}
                onChange={(e) => setEditEmpId(Number(e.target.value))}
                className="w-full rounded-lg border px-2 py-1.5 text-xs bg-white"
              >
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.full_name} ({emp.emp_code})
                  </option>
                ))}
              </select>
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
                placeholder="Catatan koreksi admin"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                className="w-full rounded-lg border px-2.5 py-1.5 text-xs bg-white"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void saveEditEntry()}
                  className="px-3 py-1 rounded-lg bg-emerald-600 text-white text-xs font-bold"
                >
                  Simpan Waktu
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
                    <td colSpan={8} className="p-4 text-center text-slate-400">
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
                          {item.entry_type === "CLOCK_IN" ? "MASUK" : "KELUAR"}
                        </td>
                        <td className="p-1.5 whitespace-nowrap">
                          {formatTimeWIB(item.punched_at)}
                        </td>
                        <td className="p-1.5 whitespace-nowrap">
                          {lateM > 0 ? `${lateM}m` : "0m"}
                        </td>
                        <td className="p-1.5 whitespace-nowrap">
                          {item.is_within_geofence === false ? "LUAR" : "HADIR"}
                        </td>
                        <td className="p-1.5 whitespace-nowrap">
                          {item.mode || "QR + GPS"}
                        </td>
                        <td className="p-1.5 whitespace-nowrap space-x-1">
                          <button
                            type="button"
                            onClick={() => openEditEntry(item)}
                            className="px-1.5 py-0.5 rounded bg-amber-500 text-white font-bold"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteEntry(item)}
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
            Cetak atau tampilkan QR Code ini di lokasi kantor. Sistem mengunci
            pemindaian agar karyawan hanya bisa absen <b>MASUK</b> dan{" "}
            <b>KELUAR</b> memakai QR resmi ini.
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

        {/* 5. Panel Admin: Data Karyawan & Edit Latitude / Longitude Koordinat */}
        <section className="bg-white rounded-2xl p-3.5 border border-slate-200/80 shadow-sm space-y-3">
          <h2 className="text-xs font-extrabold text-slate-800">
            5. Panel Admin: Data Karyawan
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
                <option value="ADMIN">ADMIN</option>
                <option value="MANAGER">MANAGER</option>
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
              {empForm.id ? "Simpan Edit Anggota" : "Tambah Anggota Karyawan"}
            </button>
          </div>

          <div className="space-y-1.5">
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
                      onClick={() => void deleteEmployee(emp)}
                      className="px-2 py-0.5 rounded bg-rose-600 text-white text-[10px] font-bold"
                    >
                      Hapus
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Edit Koordinat Latitude, Longitude & Radius GPS */}
          <div className="pt-2.5 border-t border-slate-200 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-extrabold text-slate-800">
                Edit Koordinat Latitude, Longitude &amp; Radius GPS
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
                  Ambil GPS Saat Ini
                </button>
              )}
            </div>

            <input
              type="text"
              placeholder="Nama Lokasi Kantor"
              value={locForm.name}
              onChange={(e) =>
                setLocForm((p) => ({ ...p, name: e.target.value }))
              }
              className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
            />
            <div className="grid grid-cols-3 gap-1.5">
              <div>
                <label className="block text-[9px] font-bold text-slate-500 mb-0.5">
                  Latitude
                </label>
                <input
                  type="text"
                  placeholder="-6.910000"
                  value={locForm.latitude}
                  onChange={(e) =>
                    setLocForm((p) => ({ ...p, latitude: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-[9px] font-bold text-slate-500 mb-0.5">
                  Longitude
                </label>
                <input
                  type="text"
                  placeholder="109.730000"
                  value={locForm.longitude}
                  onChange={(e) =>
                    setLocForm((p) => ({ ...p, longitude: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-[9px] font-bold text-slate-500 mb-0.5">
                  Radius (m)
                </label>
                <input
                  type="number"
                  placeholder="150"
                  value={locForm.radius_meters}
                  onChange={(e) =>
                    setLocForm((p) => ({
                      ...p,
                      radius_meters: e.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => void saveLocationCoordinates()}
              className="w-full py-2 rounded-lg bg-emerald-700 text-white text-xs font-bold"
            >
              Simpan Koordinat &amp; Radius
            </button>

            <div className="space-y-1">
              {locations.map((loc) => (
                <div
                  key={loc.id}
                  className="p-2 rounded-lg bg-slate-50 border border-slate-200/70 flex items-center justify-between text-[11px]"
                >
                  <div>
                    <div className="font-bold text-slate-800">{loc.name}</div>
                    <div className="text-[10px] text-slate-500">
                      Lat: {loc.latitude}, Lng: {loc.longitude} • Radius{" "}
                      {loc.radius_meters}m
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setLocForm({
                          id: loc.id,
                          name: loc.name,
                          latitude: String(loc.latitude),
                          longitude: String(loc.longitude),
                          radius_meters: String(loc.radius_meters),
                        })
                      }
                      className="px-2 py-0.5 rounded bg-amber-500 text-white text-[10px] font-bold"
                    >
                      Edit
                    </button>
                    {locations.length > 1 && (
                      <button
                        type="button"
                        onClick={() => void deleteLocation(loc.id)}
                        className="px-2 py-0.5 rounded bg-rose-600 text-white text-[10px] font-bold"
                      >
                        Hapus
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
