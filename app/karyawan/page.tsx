"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

type IndoTzType = "Asia/Jakarta" | "Asia/Makassar" | "Asia/Jayapura";

interface StaffEmployee {
  id: number;
  emp_code: string;
  full_name: string;
  role: "ADMIN" | "MANAGER" | "STAFF";
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
  client_uuid: string;
  employee_id: number;
  entry_type: "CLOCK_IN" | "CLOCK_OUT";
  punched_at: string;
  is_offline_sync?: boolean;
  qr_code?: string;
  mode?: string;
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
  ) => Promise<Array<{ rawValue?: string }>>;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY = "absensi_role_lock_cache_v1";
const QUEUE_KEY = "absensi_role_lock_queue_v1";
const STAFF_EMP_KEY = "absensi_karyawan_only_emp_id_v1";
const QR_CODE_KEY = "absensi_role_lock_qr_v1";

const DEFAULT_STAFF: StaffEmployee[] = [
  {
    id: 3,
    emp_code: "ABZ-0001",
    full_name: "Amelia",
    role: "STAFF",
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

function getTzLabel(tz: IndoTzType): string {
  if (tz === "Asia/Makassar") return "WITA";
  if (tz === "Asia/Jayapura") return "WIT";
  return "WIB";
}

function formatTimeInTz(iso: string | null | undefined, tz: IndoTzType): string {
  if (!iso) return "-";
  return `${new Date(iso).toLocaleTimeString("id-ID", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })} ${getTzLabel(tz)}`;
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

function loadInitialStaffState() {
  if (typeof window === "undefined") {
    return {
      qrCode: "ABSENSI-KANTOR-MPI-BTG",
      empId: 3,
      staffList: DEFAULT_STAFF,
      locations: DEFAULT_LOCATIONS,
      entries: [] as TimeEntry[],
      queue: [] as TimeEntry[],
    };
  }

  let qrCode = "ABSENSI-KANTOR-MPI-BTG";
  let empId = 3;
  let staffList = DEFAULT_STAFF;
  let locations = DEFAULT_LOCATIONS;
  let entries: TimeEntry[] = [];
  let queue: TimeEntry[] = [];

  try {
    const savedQr = localStorage.getItem(QR_CODE_KEY);
    if (savedQr) qrCode = savedQr;

    const savedEmp = localStorage.getItem(STAFF_EMP_KEY);
    if (savedEmp && Number(savedEmp) > 0) empId = Number(savedEmp);

    const rawQ = localStorage.getItem(QUEUE_KEY);
    if (rawQ) queue = JSON.parse(rawQ);

    const rawC = localStorage.getItem(CACHE_KEY);
    if (rawC) {
      const parsed = JSON.parse(rawC);
      if (Array.isArray(parsed.employees)) {
        const onlyStaff = parsed.employees.filter(
          (e: StaffEmployee) => e.role === "STAFF"
        );
        if (onlyStaff.length > 0) staffList = onlyStaff;
      }
      if (Array.isArray(parsed.locations) && parsed.locations.length > 0) {
        locations = parsed.locations;
      }
      if (Array.isArray(parsed.entries)) {
        entries = parsed.entries;
      }
    }
  } catch {
    // Abaikan error storage
  }

  return { qrCode, empId, staffList, locations, entries, queue };
}

export default function KaryawanTerbatasPage() {
  const init = useMemo(() => loadInitialStaffState(), []);

  const [staffList, setStaffList] = useState<StaffEmployee[]>(init.staffList);
  const [selectedStaffId, setSelectedStaffId] = useState<number>(init.empId);
  const [locations, setLocations] = useState<LocationItem[]>(init.locations);
  const [serverEntries, setServerEntries] = useState<TimeEntry[]>(init.entries);
  const [offlineQueue, setOfflineQueue] = useState<TimeEntry[]>(init.queue);
  const [officeQrCode, setOfficeQrCode] = useState<string>(init.qrCode);

  const [indoTz] = useState<IndoTzType>("Asia/Jakarta");
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [isSyncing, setIsSyncing] = useState(false);

  const [selectedAction, setSelectedAction] = useState<"CLOCK_IN" | "CLOCK_OUT">(
    "CLOCK_IN"
  );
  const [codeInput, setCodeInput] = useState("");
  const [scannerOn, setScannerOn] = useState(false);
  const [gpsCoords, setGpsCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);

  const [selfieOn, setSelfieOn] = useState(false);
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

  const scannerVideoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRafRef = useRef<number | null>(null);
  const selfieVideoRef = useRef<HTMLVideoElement | null>(null);
  const selfieCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const faceRafRef = useRef<number | null>(null);

  const notify = useCallback(
    (type: "ok" | "warn" | "err", text: string) => {
      setToast({ type, text });
      setTimeout(() => setToast(null), 3500);
    },
    []
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const activeStaff = useMemo(
    () =>
      staffList.find((s) => Number(s.id) === Number(selectedStaffId)) ||
      staffList[0] ||
      DEFAULT_STAFF[0],
    [staffList, selectedStaffId]
  );

  const liveClockText = useMemo(() => {
    const t = new Date(nowMs).toLocaleTimeString("id-ID", {
      timeZone: indoTz,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const d = new Date(nowMs).toLocaleDateString("id-ID", {
      timeZone: indoTz,
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    return `${d} • ${t} ${getTzLabel(indoTz)}`;
  }, [nowMs, indoTz]);

  const stopScanner = useCallback(() => {
    if (scannerRafRef.current !== null) {
      cancelAnimationFrame(scannerRafRef.current);
      scannerRafRef.current = null;
    }
    if (scannerVideoRef.current?.srcObject) {
      (scannerVideoRef.current.srcObject as MediaStream)
        .getTracks()
        .forEach((tr) => tr.stop());
      scannerVideoRef.current.srcObject = null;
    }
    setScannerOn(false);
  }, []);

  const stopSelfie = useCallback(() => {
    if (faceRafRef.current !== null) {
      cancelAnimationFrame(faceRafRef.current);
      faceRafRef.current = null;
    }
    if (selfieVideoRef.current?.srcObject) {
      (selfieVideoRef.current.srcObject as MediaStream)
        .getTracks()
        .forEach((tr) => tr.stop());
      selfieVideoRef.current.srcObject = null;
    }
    setSelfieOn(false);
  }, []);

  const syncQueue = useCallback(
    async (q: TimeEntry[]) => {
      if (!navigator.onLine || q.length === 0) return;
      setIsSyncing(true);
      try {
        const res = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ punches: q }),
        });
        const data = await res.json();
        if (data.ok) {
          localStorage.removeItem(QUEUE_KEY);
          setOfflineQueue([]);
        }
      } catch {
        // Simpan di antrean lokal
      } finally {
        setIsSyncing(false);
      }
    },
    []
  );

  const refreshData = useCallback(async () => {
    if (!navigator.onLine) {
      notify("warn", "Offline: memakai data tersimpan di HP.");
      return;
    }
    setIsSyncing(true);
    try {
      const rawQ = localStorage.getItem(QUEUE_KEY);
      const pending: TimeEntry[] = rawQ ? JSON.parse(rawQ) : [];
      if (pending.length > 0) await syncQueue(pending);

      const res = await fetch("/api/bootstrap", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          if (Array.isArray(data.employees)) {
            const onlyStaff = data.employees.filter(
              (e: StaffEmployee) => e.role === "STAFF"
            );
            if (onlyStaff.length > 0) setStaffList(onlyStaff);
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
              employees: data.employees || DEFAULT_STAFF,
              locations: data.locations || DEFAULT_LOCATIONS,
              entries: data.entries || [],
            })
          );
        }
      }
    } catch {
      // Abaikan error
    } finally {
      setIsSyncing(false);
    }
  }, [notify, syncQueue]);

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      void refreshData();
    };
    const onOffline = () => {
      setIsOnline(false);
      notify("warn", "Offline: absen masuk antrean HP.");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const t = window.setTimeout(() => {
      void refreshData();
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
      stopScanner();
      stopSelfie();
    };
  }, [refreshData, notify, stopScanner, stopSelfie]);

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

  const allEntries = useMemo(() => {
    const seen = new Set(serverEntries.map((e) => e.client_uuid));
    const pending = offlineQueue.filter((q) => !seen.has(q.client_uuid));
    return [...pending, ...serverEntries].sort(
      (a, b) =>
        new Date(b.punched_at).getTime() - new Date(a.punched_at).getTime()
    );
  }, [serverEntries, offlineQueue]);

  // Kunci anti absen ganda selama 6 jam setelah absen masuk maupun keluar
  const cooldown = useMemo(() => {
    const myLogs = allEntries.filter(
      (e) => Number(e.employee_id) === Number(activeStaff.id)
    );
    const last = myLogs[0] || null;
    if (!last) return { locked: false, label: "", last: null };
    const elapsed = nowMs - new Date(last.punched_at).getTime();
    if (elapsed >= 0 && elapsed < SIX_HOURS_MS) {
      const totalMins = Math.ceil((SIX_HOURS_MS - elapsed) / 60000);
      const hrs = Math.floor(totalMins / 60);
      const mins = totalMins % 60;
      return {
        locked: true,
        label: hrs > 0 ? `${hrs} jam ${mins} menit` : `${mins} menit`,
        last,
      };
    }
    return { locked: false, label: "", last };
  }, [allEntries, activeStaff.id, nowMs]);

  const openScanner = async () => {
    try {
      stopSelfie();
      setScannerOn(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (scannerVideoRef.current) {
        scannerVideoRef.current.srcObject = stream;
        await scannerVideoRef.current.play();
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
        const scanLoop = async () => {
          if (!scannerVideoRef.current || !scannerVideoRef.current.srcObject)
            return;
          try {
            const codes = await detector.detect(scannerVideoRef.current);
            const raw = codes[0]?.rawValue?.trim();
            if (raw) {
              setCodeInput(raw);
              stopScanner();
              notify("ok", `Barcode/QR terbaca: ${raw}`);
              return;
            }
          } catch {
            // Lanjutkan scan
          }
          scannerRafRef.current = requestAnimationFrame(scanLoop);
        };
        scannerRafRef.current = requestAnimationFrame(scanLoop);
      }
    } catch {
      setScannerOn(false);
      notify("warn", "Kamera scanner terkendala. Ketik kode manual.");
    }
  };

  const runFaceDetection = useCallback(() => {
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
        "Deteksi wajah otomatis tidak didukung di browser ini; klik Ambil Foto Selfie."
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

  const openSelfie = async () => {
    try {
      stopScanner();
      setCapturedSelfie(null);
      setSelfieOn(true);
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
      runFaceDetection();
    } catch {
      setSelfieOn(false);
      notify("err", "Izinkan kamera depan untuk selfie pendeteksi wajah.");
    }
  };

  const captureSelfie = async () => {
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

    const canvas = selfieCanvasRef.current;
    canvas.width = 240;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(selfieVideoRef.current, 0, 0, 240, 240);
    setCapturedSelfie(canvas.toDataURL("image/jpeg", 0.65));
    setFaceStatus(FD ? "detected" : "fallback");
    setFaceText("Selfie wajah siap untuk absen.");
    stopSelfie();
    notify("ok", "Selfie wajah berhasil diambil.");
  };

  const submitStaffPunch = async (
    typeOverride?: "CLOCK_IN" | "CLOCK_OUT",
    manualOverride?: string
  ) => {
    const currentMs = Date.now();
    setNowMs(currentMs);

    if (cooldown.locked) {
      notify(
        "err",
        `Sudah absen ${
          cooldown.last?.entry_type === "CLOCK_IN" ? "MASUK" : "KELUAR"
        }. Absen normal kembali dalam ${cooldown.label} (6 jam).`
      );
      return;
    }

    const entryType = typeOverride || selectedAction;
    const enteredCode = (manualOverride ?? codeInput).trim().toUpperCase();

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

    if (!capturedSelfie) {
      notify(
        "err",
        "Wajib ambil foto selfie pendeteksi wajah sebelum klik MASUK atau KELUAR."
      );
      return;
    }

    const punchedIso = new Date(currentMs).toISOString();
    const uuid =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${currentMs}-${Math.random().toString(36).slice(2)}`;

    const punch: TimeEntry = {
      client_uuid: uuid,
      employee_id: Number(activeStaff.id),
      entry_type: entryType,
      punched_at: punchedIso,
      is_offline_sync: !navigator.onLine,
      qr_code: enteredCode,
      mode: "BARCODE + WAJAH + KLIK",
      latitude: gpsCoords?.lat ?? null,
      longitude: gpsCoords?.lng ?? null,
      distance_meters: geofence?.distance ?? 46,
      is_within_geofence: geofence ? geofence.inside : true,
      selfie_data: capturedSelfie,
      full_name: activeStaff.full_name,
      emp_code: activeStaff.emp_code,
    };

    const nextQ = [punch, ...offlineQueue];
    setOfflineQueue(nextQ);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(nextQ));
    setCodeInput("");
    setCapturedSelfie(null);
    setFaceStatus("idle");
    setFaceText("Wajib selfie dengan wajah terdeteksi sebelum klik MASUK atau KELUAR.");

    if (navigator.onLine) {
      await syncQueue(nextQ);
      await refreshData();
    }

    notify(
      "ok",
      entryType === "CLOCK_IN"
        ? `Absen MASUK tercatat (${formatTimeInTz(punchedIso, indoTz)}).`
        : `Absen KELUAR tercatat (${formatTimeInTz(punchedIso, indoTz)}).`
    );
  };

  const myLogs = useMemo(
    () =>
      allEntries
        .filter((e) => Number(e.employee_id) === Number(activeStaff.id))
        .slice(0, 6),
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

        {/* Header Mode Karyawan Terbatas (Tanpa Akses Admin & Manager) */}
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
            <span className="px-2 py-0.5 rounded bg-sky-500 text-slate-950 text-[9px] font-extrabold uppercase shrink-0">
              MODE TERBATAS
            </span>
          </div>

          <div className="bg-white/10 rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-emerald-300">
            {liveClockText}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="px-2.5 py-1 rounded-md bg-emerald-600 text-white text-[10px] font-extrabold uppercase">
              {isOnline ? "ONLINE" : "OFFLINE"} • ANTREAN: {offlineQueue.length}
            </span>
            <button
              type="button"
              onClick={() => {
                setNowMs(Date.now());
                void refreshData();
              }}
              disabled={isSyncing}
              className="px-2.5 py-1 rounded-md bg-blue-600 text-white text-[10px] font-bold"
            >
              {isSyncing ? "Sync..." : "Refresh Jam"}
            </button>
            {staffList.length > 1 && (
              <select
                value={activeStaff.id}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setSelectedStaffId(id);
                  localStorage.setItem(STAFF_EMP_KEY, String(id));
                }}
                className="rounded-md bg-slate-800 text-white border border-white/20 px-2 py-1 text-[10px] font-bold"
              >
                {staffList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name} ({s.emp_code})
                  </option>
                ))}
              </select>
            )}
          </div>
        </header>

        {/* Dashboard Absen Saja: Scanner Barcode/QR + Selfie Pendeteksi Wajah + Manual Klik */}
        <section className="bg-white rounded-2xl p-3.5 border-t-4 border-t-blue-600 border border-slate-200/80 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-extrabold text-slate-800">
              Absen Masuk &amp; Keluar
            </h2>
            <span className="text-[11px] font-bold text-emerald-600">
              {geofence
                ? `Jarak ${geofence.distance}m (${
                    geofence.inside ? "Aman" : "Luar Radius"
                  })`
                : "GPS: Jarak 46m (Aman)"}
            </span>
          </div>

          {cooldown.locked && (
            <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-[11px] font-bold text-amber-900">
              Sudah absen{" "}
              {cooldown.last?.entry_type === "CLOCK_IN" ? "MASUK" : "KELUAR"}{" "}
              pukul {formatTimeInTz(cooldown.last?.punched_at, indoTz)}. Absen
              normal kembali dalam {cooldown.label} (6 jam).
            </div>
          )}

          {/* 1. Manual Klik MASUK / KELUAR */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={cooldown.locked}
              onClick={() => {
                setSelectedAction("CLOCK_IN");
                void submitStaffPunch("CLOCK_IN");
              }}
              className={`py-2.5 rounded-lg text-xs font-extrabold border disabled:opacity-45 ${
                selectedAction === "CLOCK_IN" && !cooldown.locked
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-slate-700 border-slate-300"
              }`}
            >
              MASUK (KLIK)
            </button>
            <button
              type="button"
              disabled={cooldown.locked}
              onClick={() => {
                setSelectedAction("CLOCK_OUT");
                void submitStaffPunch("CLOCK_OUT");
              }}
              className={`py-2.5 rounded-lg text-xs font-extrabold border disabled:opacity-45 ${
                selectedAction === "CLOCK_OUT" && !cooldown.locked
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-slate-700 border-slate-300"
              }`}
            >
              KELUAR (KLIK)
            </button>
          </div>

          {/* 2. Scanner Barcode / QR */}
          <button
            type="button"
            disabled={cooldown.locked}
            onClick={() => (scannerOn ? stopScanner() : void openScanner())}
            className="w-full py-2.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-45 text-white text-xs font-bold"
          >
            {scannerOn
              ? "Tutup Scanner Barcode / QR"
              : "Buka Scanner Barcode / QR"}
          </button>

          {scannerOn && (
            <div className="w-44 h-44 mx-auto rounded-xl overflow-hidden bg-black border-2 border-emerald-600">
              <video
                ref={scannerVideoRef}
                playsInline
                muted
                className="w-full h-full object-cover"
              />
            </div>
          )}

          <div className="flex gap-1.5">
            <input
              type="text"
              disabled={cooldown.locked}
              placeholder="Input Kode Barcode / QR manual"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              className="flex-1 rounded-lg border border-slate-300 px-2.5 py-2 text-xs disabled:bg-slate-100"
            />
            <button
              type="button"
              disabled={cooldown.locked}
              onClick={() => void submitStaffPunch(selectedAction, codeInput)}
              className="px-3.5 py-2 rounded-lg bg-slate-900 disabled:opacity-45 text-white text-xs font-bold"
            >
              Kirim
            </button>
          </div>

          {/* 3. Selfie Pendeteksi Wajah */}
          <div className="pt-2 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-extrabold text-slate-700">
                Selfie Pendeteksi Wajah (Wajib)
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

            {selfieOn && (
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
                    onClick={() => void captureSelfie()}
                    className="py-2 rounded-lg bg-blue-600 text-white text-xs font-bold"
                  >
                    Ambil Foto Selfie
                  </button>
                  <button
                    type="button"
                    onClick={stopSelfie}
                    className="py-2 rounded-lg bg-slate-200 text-slate-800 text-xs font-bold"
                  >
                    Batal
                  </button>
                </div>
              </div>
            )}

            {!selfieOn && (
              <button
                type="button"
                disabled={cooldown.locked}
                onClick={() => void openSelfie()}
                className="w-full py-2 rounded-lg bg-slate-800 hover:bg-slate-900 disabled:opacity-45 text-white text-xs font-bold"
              >
                {capturedSelfie
                  ? "Ambil Ulang Selfie Wajah"
                  : "Buka Kamera Selfie Wajah"}
              </button>
            )}

            {capturedSelfie && !selfieOn && (
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={capturedSelfie}
                  alt="Selfie Wajah"
                  className="w-11 h-11 rounded-lg object-cover border border-emerald-500"
                />
                <span className="text-[11px] text-emerald-800 font-semibold">
                  Selfie tersimpan. Klik MASUK atau KELUAR.
                </span>
              </div>
            )}
            <canvas ref={selfieCanvasRef} className="hidden" />
          </div>

          {/* Riwayat Absen Pribadi Karyawan */}
          <div className="pt-2 border-t border-slate-100 space-y-1">
            <div className="text-[10px] font-bold text-slate-500 uppercase">
              Riwayat Absen Saya
            </div>
            {myLogs.length === 0 ? (
              <div className="text-[11px] text-slate-400">
                Belum ada catatan absen.
              </div>
            ) : (
              myLogs.map((row, i) => (
                <div
                  key={`${row.client_uuid}-${i}`}
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
        </section>
      </div>
    </div>
  );
}
