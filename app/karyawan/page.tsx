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

const CACHE_KEY = "absensi_v9_cache";
const QUEUE_KEY = "absensi_v9_queue";
const QR_CODE_KEY = "absensi_v9_qr";
const LOC_KEY = "absensi_v9_custom_loc";
const DEVICE_LOCK_KEY = "absensi_v9_device_locked_karyawan";
const STAFF_EMP_KEY = "absensi_v9_staff_emp_id";
const AUTH_SERVER_KEY = "absensi_v9_auth_server";

const DEFAULT_STAFF: Employee[] = [
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

function normalizeShiftTime(raw?: string | null): string {
  const s = String(raw || "").trim();
  if (!s) return "07.00";
  if (
    s.includes("15:00") ||
    s.includes("15.00") ||
    s.toLowerCase().includes("siang")
  ) {
    return "15.00";
  }
  if (
    s.includes("23:00") ||
    s.includes("23.00") ||
    s.toLowerCase().includes("malam")
  ) {
    return "23.00";
  }
  if (
    s.includes("07:00") ||
    s.includes("07.00") ||
    s.toLowerCase().includes("pagi")
  ) {
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

function parseSavedLocation(raw: string | null): LocationItem | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    const rad = Math.max(10, Number(p.radius_meters) || DEFAULT_RADIUS);
    if (
      !isNaN(lat) &&
      !isNaN(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    ) {
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

const formatTimeWIB = (iso?: string | null) =>
  !iso
    ? "-"
    : new Date(iso).toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

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

function getInitialKaryawanBoot() {
  if (typeof window === "undefined") {
    return {
      qrCode: "ABSENSI-KANTOR-MPI-BTG",
      staffEmpId: 3,
      queue: [] as TimeEntry[],
      employees: DEFAULT_STAFF,
      locations: DEFAULT_LOCATIONS,
      entries: [] as TimeEntry[],
    };
  }

  let qrCode = "ABSENSI-KANTOR-MPI-BTG";
  let staffEmpId = 3;
  let queue: TimeEntry[] = [];
  let employees = DEFAULT_STAFF;
  let locations = DEFAULT_LOCATIONS;
  let entries: TimeEntry[] = [];

  try {
    localStorage.setItem(DEVICE_LOCK_KEY, "1");
    localStorage.removeItem(AUTH_SERVER_KEY);

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
        const staffOnly = c.employees
          .map((e: Employee) => ({
            ...e,
            role: normalizeRole(e.role),
            shift_start_time: normalizeShiftTime(e.shift_start_time),
          }))
          .filter((e: Employee) => e.role === "STAFF");
        if (staffOnly.length > 0) employees = staffOnly;
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

  return { qrCode, staffEmpId, queue, employees, locations, entries };
}

export default function KaryawanPage() {
  const boot = useMemo(() => getInitialKaryawanBoot(), []);

  const [staffList, setStaffList] = useState<Employee[]>(boot.employees);
  const [staffEmpId, setStaffEmpId] = useState<number>(boot.staffEmpId);
  const [locations, setLocations] = useState<LocationItem[]>(boot.locations);
  const [serverEntries, setServerEntries] = useState<TimeEntry[]>(boot.entries);
  const [offlineQueue, setOfflineQueue] = useState<TimeEntry[]>(boot.queue);
  const [officeQrCode] = useState<string>(boot.qrCode);

  const [serverOffsetMs, setServerOffsetMs] = useState<number>(0);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [isSyncing, setIsSyncing] = useState(false);

  const [selectedAction, setSelectedAction] = useState<"CLOCK_IN" | "CLOCK_OUT">(
    "CLOCK_IN"
  );
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
    "Wajib selfie dengan wajah terdeteksi sebelum klik MASUK atau KELUAR."
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
  const offsetRef = useRef<number>(0);

  const notify = useCallback(
    (type: "ok" | "warn" | "err", text: string) => {
      setToast({ type, text });
      setTimeout(() => setToast(null), 4000);
    },
    []
  );

  useEffect(() => {
    offsetRef.current = serverOffsetMs;
  }, [serverOffsetMs]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now() + offsetRef.current);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const indonesiaClockWIB = useMemo(
    () =>
      new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
        .format(new Date(nowMs))
        .replace(",", "") +
      " • " +
      new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .format(new Date(nowMs))
        .replaceAll(":", ".") +
      " WIB",
    [nowMs]
  );

  const activeStaff = useMemo(
    () =>
      staffList.find((e) => Number(e.id) === Number(staffEmpId)) ||
      staffList[0] ||
      DEFAULT_STAFF[0],
    [staffList, staffEmpId]
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
        // Tetap di antrean lokal
      } finally {
        setIsSyncing(false);
      }
    },
    [notify]
  );

  const refreshClockAndData = useCallback(
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

        const res = await fetch("/api/bootstrap", { cache: "no-store" });
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
            let nextStaff = staffList;
            if (Array.isArray(data.employees) && data.employees.length > 0) {
              const filteredStaff = data.employees
                .map((e: Employee) => ({
                  ...e,
                  role: normalizeRole(e.role),
                  shift_start_time: normalizeShiftTime(e.shift_start_time),
                }))
                .filter((e: Employee) => e.role === "STAFF");
              if (filteredStaff.length > 0) {
                nextStaff = filteredStaff;
                setStaffList(filteredStaff);
              }
            }

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

            const nextEntries: TimeEntry[] = Array.isArray(data.entries)
              ? data.entries.map((item: TimeEntry) => ({
                  ...item,
                  entry_type: normalizeEntryType(item.entry_type),
                  client_uuid:
                    item.client_uuid ||
                    `srv-${item.id || Math.random().toString(36).slice(2)}`,
                }))
              : serverEntries;
            setServerEntries(nextEntries);

            localStorage.setItem(
              CACHE_KEY,
              JSON.stringify({
                employees: nextStaff,
                locations: nextLocs,
                entries: nextEntries,
              })
            );
            if (!silent) {
              notify("ok", "Jam WIB & data karyawan tersinkronisasi.");
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
    [notify, syncOfflineQueue, staffList, serverEntries]
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
      void refreshClockAndData(true);
    };
    const onOffline = () => {
      setIsOnline(false);
      notify("warn", "Offline: absensi masuk antrean lokal.");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const t = window.setTimeout(() => {
      void refreshClockAndData(true);
      requestCurrentGps();
    }, 0);

    return () => {
      clearTimeout(t);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      stopQrCam();
      stopSelfieCam();
    };
  }, [refreshClockAndData, requestCurrentGps, notify, stopQrCam, stopSelfieCam]);

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

  const allEntries = useMemo(() => {
    const seen = new Set(serverEntries.map((e) => e.client_uuid));
    const pending = offlineQueue.filter((q) => !seen.has(q.client_uuid));
    return [...pending, ...serverEntries].sort(
      (a, b) =>
        new Date(b.punched_at).getTime() - new Date(a.punched_at).getTime()
    );
  }, [serverEntries, offlineQueue]);

  const cooldownInfo = useMemo(() => {
    const mine = allEntries
      .filter((e) => Number(e.employee_id) === Number(activeStaff.id))
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
  }, [activeStaff.id, allEntries, nowMs]);

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

    const punchedAtIso = new Date(syncedNow).toISOString();
    const uuid =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${syncedNow}-${Math.random().toString(36).slice(2)}`;

    const newPunch: TimeEntry = {
      client_uuid: uuid,
      employee_id: Number(activeStaff.id),
      entry_type: entryType,
      punched_at: punchedAtIso,
      is_offline_sync: !navigator.onLine,
      qr_code: effectiveQr,
      mode: "BARCODE + WAJAH",
      latitude: gpsCoords.lat,
      longitude: gpsCoords.lng,
      distance_meters: geofence?.distance ?? 0,
      is_within_geofence: geofence ? geofence.inside : true,
      selfie_data: capturedSelfie,
      face_detected: Boolean(capturedSelfie && faceStatus !== "no_face"),
      full_name: activeStaff.full_name,
      emp_code: activeStaff.emp_code,
    };

    const nextQueue = [newPunch, ...offlineQueue];
    setOfflineQueue(nextQueue);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(nextQueue));
    setQrInput("");
    setCapturedSelfie(null);
    setFaceStatus("idle");
    setFaceText(
      "Wajib selfie dengan wajah terdeteksi sebelum klik MASUK atau KELUAR."
    );

    if (navigator.onLine) {
      await syncOfflineQueue(nextQueue, true);
      await refreshClockAndData(true);
    }
    notify(
      "ok",
      entryType === "CLOCK_IN"
        ? "Absen MASUK tercatat sesuai jam WIB!"
        : "Absen KELUAR tercatat sesuai jam WIB!"
    );
  };

  const myRecentEntries = useMemo(
    () =>
      allEntries
        .filter((e) => Number(e.employee_id) === Number(activeStaff.id))
        .slice(0, 5),
    [allEntries, activeStaff.id]
  );

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
                ABSENSI KARYAWAN
              </h1>
              <p className="text-[11px] text-slate-300 mt-0.5">
                {activeStaff.full_name} ({activeStaff.emp_code}) • Shift{" "}
                {activeStaff.shift_start_time || "07.00"}
              </p>
            </div>
            <span className="px-2 py-0.5 rounded bg-sky-600 text-white text-[9px] font-extrabold uppercase shrink-0">
              MODE TERBATAS
            </span>
          </div>

          <div className="text-[11px] font-mono text-emerald-300 bg-white/5 px-2.5 py-1.5 rounded-lg">
            {indonesiaClockWIB}
          </div>

          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-md bg-emerald-600 text-white text-[10px] font-extrabold uppercase">
              {isOnline ? "ONLINE" : "OFFLINE"} • ANTREAN: {offlineQueue.length}
            </span>
            <button
              type="button"
              onClick={() => {
                void refreshClockAndData(false);
                requestCurrentGps();
              }}
              disabled={isSyncing}
              className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold"
            >
              {isSyncing ? "Sinkron..." : "Refresh Jam"}
            </button>
          </div>
        </header>

        <section className="bg-white rounded-2xl p-3 border border-slate-200/80 shadow-sm space-y-1.5">
          <label className="block text-[11px] font-extrabold text-slate-700">
            Pilih Nama Karyawan
          </label>
          <select
            value={activeStaff.id}
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

        <section className="bg-white rounded-2xl p-3.5 border-t-4 border-t-blue-500 border border-slate-200/80 shadow-sm space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-extrabold text-slate-800">
              Absen Masuk &amp; Keluar
            </h2>
            <span
              className={`text-[10px] font-bold ${
                !geofence
                  ? "text-slate-500"
                  : geofence.inside
                  ? "text-emerald-700"
                  : "text-slate-400"
              }`}
            >
              {!geofence
                ? gpsStatusText
                : geofence.inside
                ? `Jarak ${geofence.distance}m (Dalam Radius)`
                : `Jarak ${geofence.distance}m (Luar Radius)`}
            </span>
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
              MASUK (KLIK)
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
              KELUAR (KLIK)
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
              placeholder={officeQrCode}
              value={qrInput}
              onChange={(e) => setQrInput(e.target.value)}
              className="flex-1 rounded-lg border border-slate-300 px-2.5 py-2 text-xs disabled:bg-slate-100"
            />
            <button
              type="button"
              disabled={cooldownInfo.locked}
              onClick={() => void submitAttendance(selectedAction, qrInput)}
              className="px-3.5 py-2 rounded-lg bg-slate-600 disabled:opacity-45 text-white text-xs font-bold"
            >
              Kirim
            </button>
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-2">
            <div className="text-[11px] font-extrabold text-slate-700">
              Selfie Pendeteksi Wajah (Wajib)
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
                className="w-full py-2.5 rounded-lg bg-slate-600 hover:bg-slate-700 disabled:opacity-45 text-white text-xs font-bold"
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
                  Selfie tersimpan. Klik MASUK (KLIK) atau KELUAR (KLIK).
                </span>
              </div>
            )}
            <canvas ref={selfieCanvasRef} className="hidden" />
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-1">
            <div className="text-[10px] font-bold text-slate-400 uppercase">
              RIWAYAT ABSEN SAYA
            </div>
            {myRecentEntries.length === 0 ? (
              <div className="text-[11px] text-slate-400">
                Belum ada catatan absen
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
        </section>
      </div>
    </div>
  );
}
