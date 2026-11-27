"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  RefreshCw,
  LogOut,
  QrCode,
  Camera,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  UserCheck,
  Download,
} from "lucide-react";

type RoleType = "ADMIN" | "MANAGER" | "STAFF";

interface Employee {
  id: number;
  emp_code: string;
  full_name: string;
  role: RoleType;
  department: string;
  pin_code: string;
}

interface LocationItem {
  id: number;
  name: string;
  address?: string;
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
  detect: (video: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
}

const CACHE_KEY = "absensi_qr_face_cache_v1";
const QUEUE_KEY = "absensi_qr_face_queue_v1";
const ACTIVE_EMP_KEY = "absensi_qr_face_emp_id_v1";
const QR_CODE_KEY = "absensi_qr_office_code_v1";

const DEFAULT_EMPLOYEES: Employee[] = [
  {
    id: 1,
    emp_code: "ABZ-0001",
    full_name: "Amelia",
    role: "STAFF",
    department: "Operasional",
    pin_code: "1111",
  },
  {
    id: 2,
    emp_code: "ADM-0001",
    full_name: "Admin Utama",
    role: "ADMIN",
    department: "Manajemen",
    pin_code: "0000",
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

export default function AbsensiQrFacePage() {
  const [employees, setEmployees] = useState<Employee[]>(DEFAULT_EMPLOYEES);
  const [locations, setLocations] = useState<LocationItem[]>(DEFAULT_LOCATIONS);
  const [serverEntries, setServerEntries] = useState<TimeEntry[]>([]);
  const [offlineQueue, setOfflineQueue] = useState<TimeEntry[]>([]);
  const [selectedEmpId, setSelectedEmpId] = useState<number>(1);
  const [adminView, setAdminView] = useState<"absen" | "monitoring">("absen");
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);

  const [isOnline, setIsOnline] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncLabel, setLastSyncLabel] = useState(() =>
    new Date().toLocaleTimeString("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
    })
  );

  const [officeQrCode, setOfficeQrCode] = useState("ABSENSI-KANTOR-MPI-BTG");
  const [qrCodeInput, setQrCodeInput] = useState("");
  const [qrVerified, setQrVerified] = useState(false);
  const [qrCameraOn, setQrCameraOn] = useState(false);

  const [gpsCoords, setGpsCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [gpsLabel, setGpsLabel] = useState("Mencari GPS...");

  const [selfieCameraOn, setSelfieCameraOn] = useState(false);
  const [capturedSelfie, setCapturedSelfie] = useState<string | null>(null);
  const [faceStatus, setFaceStatus] = useState<
    "idle" | "scanning" | "detected" | "no_face" | "fallback"
  >("idle");
  const [faceMessage, setFaceMessage] = useState(
    "Wajib ambil foto selfie wajah sebelum absen masuk atau keluar."
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [toast, setToast] = useState<{
    type: "ok" | "warn" | "err";
    text: string;
  } | null>(null);

  const qrVideoRef = useRef<HTMLVideoElement | null>(null);
  const qrRafRef = useRef<number | null>(null);
  const selfieVideoRef = useRef<HTMLVideoElement | null>(null);
  const selfieCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const faceRafRef = useRef<number | null>(null);

  const showToast = useCallback(
    (type: "ok" | "warn" | "err", text: string) => {
      setToast({ type, text });
      setTimeout(() => setToast(null), 3500);
    },
    []
  );

  const activeEmployee = useMemo(
    () =>
      employees.find((e) => Number(e.id) === Number(selectedEmpId)) ||
      employees[0],
    [employees, selectedEmpId]
  );

  const isAdmin =
    activeEmployee?.role === "ADMIN" || activeEmployee?.role === "MANAGER";

  const stopQrCamera = useCallback(() => {
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

  const stopSelfieCamera = useCallback(() => {
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

  useEffect(() => {
    setIsOnline(typeof navigator !== "undefined" ? navigator.onLine : true);
    const handleOnline = () => {
      setIsOnline(true);
      showToast("ok", "Koneksi online kembali.");
    };
    const handleOffline = () => {
      setIsOnline(false);
      showToast("warn", "Mode offline aktif. Absen disimpan di HP.");
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      stopQrCamera();
      stopSelfieCamera();
    };
  }, [showToast, stopQrCamera, stopSelfieCamera]);

  const syncQueue = useCallback(
    async (queueToSync: TimeEntry[]) => {
      if (!navigator.onLine || queueToSync.length === 0) return;
      setIsSyncing(true);
      try {
        const res = await fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ punches: queueToSync }),
        });
        const data = await res.json();
        if (data.ok) {
          localStorage.removeItem(QUEUE_KEY);
          setOfflineQueue([]);
          setLastSyncLabel(
            new Date().toLocaleTimeString("id-ID", {
              timeZone: "Asia/Jakarta",
              hour: "2-digit",
              minute: "2-digit",
            })
          );
          showToast("ok", `${data.syncedCount || queueToSync.length} data tersinkron.`);
        }
      } catch {
        // Pertahankan antrean bila jaringan gagal
      } finally {
        setIsSyncing(false);
      }
    },
    [showToast]
  );

  const loadServerData = useCallback(async () => {
    if (!navigator.onLine) return;
    try {
      const rawQ = localStorage.getItem(QUEUE_KEY);
      const pending: TimeEntry[] = rawQ ? JSON.parse(rawQ) : [];
      if (pending.length > 0) {
        await syncQueue(pending);
      }
      const res = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok) {
        if (Array.isArray(data.employees) && data.employees.length > 0) {
          setEmployees(data.employees);
          const savedEmp = localStorage.getItem(ACTIVE_EMP_KEY);
          if (!savedEmp) {
            setSelectedEmpId(Number(data.employees[0].id));
          }
        }
        if (Array.isArray(data.locations) && data.locations.length > 0) {
          setLocations(data.locations);
        }
        if (Array.isArray(data.entries)) {
          setServerEntries(data.entries);
        }
        setLastSyncLabel(
          new Date().toLocaleTimeString("id-ID", {
            timeZone: "Asia/Jakarta",
            hour: "2-digit",
            minute: "2-digit",
          })
        );
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({
            employees: data.employees || DEFAULT_EMPLOYEES,
            locations: data.locations || DEFAULT_LOCATIONS,
            entries: data.entries || [],
          })
        );
      }
    } catch {
      // Gunakan cache lokal jika server belum merespons
    }
  }, [syncQueue]);

  useEffect(() => {
    try {
      const savedQr = localStorage.getItem(QR_CODE_KEY);
      if (savedQr) setOfficeQrCode(savedQr);
      const savedEmp = localStorage.getItem(ACTIVE_EMP_KEY);
      if (savedEmp) setSelectedEmpId(Number(savedEmp));
      const rawQ = localStorage.getItem(QUEUE_KEY);
      if (rawQ) setOfflineQueue(JSON.parse(rawQ));
      const rawC = localStorage.getItem(CACHE_KEY);
      if (rawC) {
        const cached = JSON.parse(rawC);
        if (cached.employees?.length) setEmployees(cached.employees);
        if (cached.locations?.length) setLocations(cached.locations);
        if (cached.entries?.length) setServerEntries(cached.entries);
      }
    } catch {
      // Abaikan error storage
    }
    loadServerData();
  }, [loadServerData]);

  const checkGps = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setGpsLabel("GPS tidak tersedia");
      return;
    }
    setGpsLabel("Mengecek GPS...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGpsLabel(`Akurasi ±${Math.round(pos.coords.accuracy)}m`);
      },
      () => {
        setGpsLabel("Lokasi GPS aktif");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
    );
  }, []);

  useEffect(() => {
    checkGps();
  }, [checkGps]);

  const geofenceInfo = useMemo(() => {
    if (!gpsCoords || locations.length === 0) return null;
    let best = locations[0];
    let minDist = haversineMeters(
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
      if (d < minDist) {
        minDist = d;
        best = loc;
      }
    }
    return {
      location: best,
      distance: minDist,
      inside: minDist <= Number(best.radius_meters || 150),
    };
  }, [gpsCoords, locations]);

  const verifyQrValue = useCallback(
    (rawValue: string) => {
      const cleanVal = rawValue.trim().toUpperCase();
      setQrCodeInput(rawValue.trim());
      if (cleanVal && cleanVal === officeQrCode.trim().toUpperCase()) {
        setQrVerified(true);
        showToast("ok", `QR valid: ${officeQrCode}`);
        return true;
      }
      setQrVerified(false);
      return false;
    },
    [officeQrCode, showToast]
  );

  const startQrScanner = async () => {
    try {
      stopSelfieCamera();
      setQrCameraOn(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (qrVideoRef.current) {
        qrVideoRef.current.srcObject = stream;
        await qrVideoRef.current.play();
      }
      const BarcodeDetectorCtor = (
        window as unknown as {
          BarcodeDetector?: new (opts: {
            formats: string[];
          }) => BarcodeDetectorInstance;
        }
      ).BarcodeDetector;

      if (BarcodeDetectorCtor) {
        const detector = new BarcodeDetectorCtor({ formats: ["qr_code"] });
        const scanLoop = async () => {
          if (!qrVideoRef.current || !qrVideoRef.current.srcObject) return;
          try {
            const found = await detector.detect(qrVideoRef.current);
            const code = found[0]?.rawValue?.trim();
            if (code) {
              stopQrCamera();
              if (!verifyQrValue(code)) {
                showToast("err", `Kode QR tidak cocok: ${code}`);
              }
              return;
            }
          } catch {
            // Lanjutkan loop
          }
          qrRafRef.current = requestAnimationFrame(scanLoop);
        };
        qrRafRef.current = requestAnimationFrame(scanLoop);
      } else {
        showToast(
          "warn",
          "Kamera terbuka. Arahkan ke QR atau ketik kode QR kantor."
        );
      }
    } catch {
      setQrCameraOn(false);
      showToast(
        "warn",
        "Kamera QR tidak aktif. Masukkan kode QR kantor pada kolom."
      );
    }
  };

  const runFaceDetectionLoop = useCallback(() => {
    const FaceDetectorCtor = (
      window as unknown as {
        FaceDetector?: new (opts?: {
          fastMode?: boolean;
          maxDetectedFaces?: number;
        }) => FaceDetectorInstance;
      }
    ).FaceDetector;

    if (!FaceDetectorCtor) {
      setFaceStatus("fallback");
      setFaceMessage(
        "Pendeteksi wajah bawaan browser belum tersedia di perangkat ini; foto selfie tetap bisa diambil."
      );
      return;
    }

    const detector = new FaceDetectorCtor({
      fastMode: true,
      maxDetectedFaces: 1,
    });
    setFaceStatus("scanning");
    setFaceMessage("Mendeteksi wajah pada kamera depan...");

    const detectStep = async () => {
      if (!selfieVideoRef.current || !selfieVideoRef.current.srcObject) return;
      try {
        const faces = await detector.detect(selfieVideoRef.current);
        if (faces.length > 0) {
          setFaceStatus("detected");
          setFaceMessage("Wajah terdeteksi! Tekan tombol Ambil Selfie.");
        } else {
          setFaceStatus("no_face");
          setFaceMessage("Wajah belum terlihat. Posisikan wajah di tengah kamera.");
        }
      } catch {
        setFaceStatus("fallback");
        setFaceMessage("Deteksi wajah otomatis dilewati, silakan ambil foto selfie.");
        return;
      }
      faceRafRef.current = requestAnimationFrame(detectStep);
    };
    faceRafRef.current = requestAnimationFrame(detectStep);
  }, []);

  const startSelfieCamera = async () => {
    try {
      stopQrCamera();
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
      runFaceDetectionLoop();
    } catch {
      setSelfieCameraOn(false);
      showToast("err", "Izinkan akses kamera depan untuk foto selfie wajah.");
    }
  };

  const captureSelfiePhoto = async () => {
    if (!selfieVideoRef.current || !selfieCanvasRef.current) return;
    const canvas = selfieCanvasRef.current;
    canvas.width = 240;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let hasFace = faceStatus === "detected";
    const FaceDetectorCtor = (
      window as unknown as {
        FaceDetector?: new (opts?: {
          fastMode?: boolean;
          maxDetectedFaces?: number;
        }) => FaceDetectorInstance;
      }
    ).FaceDetector;

    if (!hasFace && FaceDetectorCtor) {
      try {
        const detector = new FaceDetectorCtor({
          fastMode: true,
          maxDetectedFaces: 1,
        });
        const faces = await detector.detect(selfieVideoRef.current);
        hasFace = faces.length > 0;
      } catch {
        hasFace = false;
      }
    }

    if (FaceDetectorCtor && !hasFace) {
      setFaceStatus("no_face");
      setFaceMessage(
        "Wajah tidak terdeteksi pada foto. Pastikan wajah terlihat jelas di kamera."
      );
      showToast("err", "Wajah belum terdeteksi! Arahkan wajah ke kamera.");
      return;
    }

    ctx.drawImage(selfieVideoRef.current, 0, 0, 240, 240);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.65);
    setCapturedSelfie(dataUrl);
    setFaceStatus(FaceDetectorCtor ? "detected" : "fallback");
    setFaceMessage(
      FaceDetectorCtor
        ? "Foto selfie dengan wajah terdeteksi siap digunakan."
        : "Foto selfie tersimpan (mode standar browser)."
    );
    stopSelfieCamera();
    showToast("ok", "Foto selfie berhasil diambil.");
  };

  const handleAbsenSubmit = async (entryType: "CLOCK_IN" | "CLOCK_OUT") => {
    if (!activeEmployee) return;
    const enteredQr = qrCodeInput.trim().toUpperCase();
    const validQr = enteredQr === officeQrCode.trim().toUpperCase();

    if (!validQr) {
      setQrVerified(false);
      showToast(
        "err",
        "Scan atau masukkan kode QR resmi kantor terlebih dahulu."
      );
      return;
    }
    setQrVerified(true);

    if (!capturedSelfie) {
      showToast(
        "err",
        "Foto selfie deteksi wajah wajib diambil sebelum absen."
      );
      return;
    }

    if (geofenceInfo && !geofenceInfo.inside) {
      showToast(
        "err",
        `Di luar radius kantor (${geofenceInfo.distance}m > ${geofenceInfo.location.radius_meters}m).`
      );
      return;
    }

    setIsSubmitting(true);
    const uuid =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const newPunch: TimeEntry = {
      client_uuid: uuid,
      employee_id: Number(activeEmployee.id),
      entry_type: entryType,
      punched_at: new Date().toISOString(),
      is_offline_sync: !navigator.onLine,
      qr_code: enteredQr,
      latitude: gpsCoords?.lat ?? null,
      longitude: gpsCoords?.lng ?? null,
      distance_meters: geofenceInfo?.distance ?? null,
      is_within_geofence: geofenceInfo ? geofenceInfo.inside : true,
      selfie_data: capturedSelfie,
      face_detected: faceStatus === "detected",
      full_name: activeEmployee.full_name,
      emp_code: activeEmployee.emp_code,
    };

    try {
      const nextQueue = [newPunch, ...offlineQueue];
      setOfflineQueue(nextQueue);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(nextQueue));

      if (navigator.onLine) {
        try {
          const res = await fetch("/api/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ punches: nextQueue }),
          });
          const data = await res.json();
          if (data.ok) {
            localStorage.removeItem(QUEUE_KEY);
            setOfflineQueue([]);
            await loadServerData();
          }
        } catch {
          // Data tetap aman di antrean lokal
        }
      }

      setCapturedSelfie(null);
      setQrCodeInput("");
      setQrVerified(false);
      setFaceStatus("idle");
      setFaceMessage(
        "Wajib ambil foto selfie wajah sebelum absen masuk atau keluar."
      );
      showToast(
        "ok",
        entryType === "CLOCK_IN"
          ? "Absen Masuk berhasil dicatat!"
          : "Absen Keluar berhasil dicatat!"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeluarSession = () => {
    stopQrCamera();
    stopSelfieCamera();
    setQrCodeInput("");
    setQrVerified(false);
    setCapturedSelfie(null);
    setAccountPickerOpen(true);
  };

  const combinedEntries = useMemo(() => {
    const seen = new Set(serverEntries.map((e) => e.client_uuid));
    const pendingOnly = offlineQueue.filter((q) => !seen.has(q.client_uuid));
    return [...pendingOnly, ...serverEntries].sort(
      (a, b) =>
        new Date(b.punched_at).getTime() - new Date(a.punched_at).getTime()
    );
  }, [serverEntries, offlineQueue]);

  const myRecentEntries = useMemo(() => {
    if (!activeEmployee) return [];
    return combinedEntries
      .filter((e) => Number(e.employee_id) === Number(activeEmployee.id))
      .slice(0, 6);
  }, [combinedEntries, activeEmployee]);

  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
    officeQrCode
  )}`;

  return (
    <div className="min-h-screen bg-[#EEF1F5] text-slate-900 p-3 sm:p-5">
      <div className="max-w-lg mx-auto space-y-4">
        {toast && (
          <div
            className={`px-4 py-2.5 rounded-xl text-white text-xs font-bold flex items-center gap-2 shadow ${
              toast.type === "ok"
                ? "bg-emerald-600"
                : toast.type === "warn"
                ? "bg-amber-600"
                : "bg-rose-600"
            }`}
          >
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{toast.text}</span>
          </div>
        )}

        {/* Header Status Aplikasi */}
        <section className="bg-[#0B1220] text-white rounded-2xl p-4 shadow space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h1 className="text-base font-extrabold tracking-wide uppercase">
                APLIKASI ABSENSI QR &amp; GPS
              </h1>
              <p className="text-xs text-slate-300 mt-0.5">
                {activeEmployee?.full_name || "Karyawan"} (
                {activeEmployee?.emp_code || "-"}) • Sync: {lastSyncLabel} WIB
              </p>
            </div>
            <span
              className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${
                isAdmin
                  ? "bg-amber-500/20 text-amber-300 border border-amber-400/30"
                  : "bg-sky-500/20 text-sky-300 border border-sky-400/30"
              }`}
            >
              {isAdmin ? "ADMIN" : "MODE TERBATAS"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`px-3 py-1 rounded-full text-[11px] font-extrabold tracking-wide ${
                isOnline
                  ? "bg-emerald-500/20 text-emerald-300"
                  : "bg-amber-500/20 text-amber-300"
              }`}
            >
              {isOnline ? "ONLINE" : "OFFLINE"} • ANTREAN: {offlineQueue.length}
            </span>
            <span className="px-3 py-1 rounded-full text-[11px] font-extrabold bg-emerald-600 text-white">
              {isAdmin ? "LIVE 3d: ON" : "ABSEN QR & WAJAH"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => loadServerData()}
              disabled={isSyncing}
              className="py-2.5 px-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center justify-center gap-1.5"
            >
              <RefreshCw
                className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
              />
              <span>Refresh Server</span>
            </button>
            <button
              type="button"
              onClick={handleKeluarSession}
              className="py-2.5 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center gap-1.5"
            >
              <LogOut className="w-4 h-4" />
              <span>Keluar</span>
            </button>
          </div>
        </section>

        {/* Pemilih Akun / Ganti Sesi */}
        {accountPickerOpen && (
          <section className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold text-slate-800 uppercase">
                Pilih Akun Pengguna
              </span>
              <button
                type="button"
                onClick={() => setAccountPickerOpen(false)}
                className="text-xs font-bold text-slate-500 px-2 py-1 rounded bg-slate-100"
              >
                Tutup
              </button>
            </div>
            <div className="space-y-1.5">
              {employees.map((emp) => {
                const selected = Number(emp.id) === Number(activeEmployee?.id);
                return (
                  <button
                    key={emp.id}
                    type="button"
                    onClick={() => {
                      setSelectedEmpId(Number(emp.id));
                      localStorage.setItem(ACTIVE_EMP_KEY, String(emp.id));
                      setAccountPickerOpen(false);
                      setAdminView("absen");
                      showToast(
                        "ok",
                        `Beralih ke ${emp.full_name} (${emp.role})`
                      );
                    }}
                    className={`w-full p-3 rounded-xl border text-left flex items-center justify-between ${
                      selected
                        ? "border-blue-600 bg-blue-50"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div>
                      <div className="text-sm font-bold text-slate-900">
                        {emp.full_name}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {emp.emp_code} • {emp.role}
                      </div>
                    </div>
                    <UserCheck className="w-4 h-4 text-slate-600" />
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Navigasi Khusus Admin Saja (Karyawan Tidak Bisa Akses Fitur Lain) */}
        {isAdmin && (
          <section className="bg-white rounded-2xl p-3 border border-slate-200 shadow-sm space-y-2.5">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAdminView("monitoring")}
                className={`py-2.5 px-3 rounded-xl text-xs font-bold ${
                  adminView === "monitoring"
                    ? "bg-blue-600 text-white"
                    : "bg-slate-100 text-slate-700"
                }`}
              >
                Monitoring &amp; Absen Langsung
              </button>
              <button
                type="button"
                onClick={() => setAdminView("absen")}
                className={`py-2.5 px-3 rounded-xl text-xs font-bold ${
                  adminView === "absen"
                    ? "bg-blue-600 text-white"
                    : "bg-slate-100 text-slate-700"
                }`}
              >
                Scan QR &amp; GPS
              </button>
            </div>
          </section>
        )}

        {/* Tampilan Monitoring Khusus Admin */}
        {isAdmin && adminView === "monitoring" ? (
          <section className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
              <div className="flex items-center gap-2 font-bold text-sm text-slate-900">
                <ShieldCheck className="w-4 h-4 text-blue-600" />
                <span>Monitoring Absensi Terbaru</span>
              </div>
              <span className="text-xs font-bold text-slate-500">
                {combinedEntries.length} catatan
              </span>
            </div>

            <div className="space-y-2 max-h-96 overflow-y-auto">
              {combinedEntries.length === 0 ? (
                <p className="text-xs text-slate-500 py-4 text-center">
                  Belum ada data absensi masuk.
                </p>
              ) : (
                combinedEntries.map((item, idx) => (
                  <div
                    key={`${item.client_uuid}-${idx}`}
                    className="p-3 rounded-xl bg-slate-50 border border-slate-200/70 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {item.selfie_data ? (
                        <img
                          src={item.selfie_data}
                          alt={item.full_name || "Selfie"}
                          className="w-11 h-11 rounded-lg object-cover border shrink-0"
                        />
                      ) : (
                        <div className="w-11 h-11 rounded-lg bg-slate-200 text-xs font-bold flex items-center justify-center shrink-0">
                          QR
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-900 truncate">
                          {item.full_name || "Karyawan"} ({item.emp_code || "-"})
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {item.entry_type === "CLOCK_IN"
                            ? "ABSEN MASUK"
                            : "ABSEN KELUAR"}{" "}
                          • {formatTimeWIB(item.punched_at)}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">
                          QR: {item.qr_code || "-"} • Wajah:{" "}
                          {item.face_detected ? "Terdeteksi" : "Standar"}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* QR Code Resmi & Download Khusus Admin */}
            <div className="pt-3 border-t border-slate-100 text-center space-y-2">
              <div className="text-xs font-extrabold text-slate-800">
                QR Code Resmi Kantor (Khusus Admin)
              </div>
              <input
                type="text"
                value={officeQrCode}
                onChange={(e) => {
                  setOfficeQrCode(e.target.value);
                  localStorage.setItem(QR_CODE_KEY, e.target.value);
                }}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-center"
              />
              <img
                src={qrImageUrl}
                alt="QR Code Resmi"
                className="w-44 h-44 mx-auto rounded-xl border border-slate-200 p-2 bg-white"
              />
              <div className="text-xs font-extrabold text-slate-900">
                {officeQrCode}
              </div>
              <a
                href={qrImageUrl}
                download={`${officeQrCode}.png`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-700 text-white text-xs font-bold"
              >
                <Download className="w-4 h-4" />
                <span>Download PNG</span>
              </a>
            </div>
          </section>
        ) : (
          /* Mode Terbatas Karyawan: Hanya Absen Masuk & Keluar via Scan QR + Selfie Deteksi Wajah */
          <section className="bg-white rounded-2xl p-4 border-2 border-blue-200 shadow-sm space-y-4">
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-base font-extrabold text-slate-900">
                  Absen Real-Time Saya ({activeEmployee?.full_name || "Karyawan"})
                </h2>
                <p className="text-[11px] text-slate-500">
                  Mode terbatas: wajib Scan QR Code &amp; Foto Selfie Wajah •{" "}
                  {gpsLabel}
                </p>
              </div>
              <span className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 text-[10px] font-extrabold uppercase shrink-0">
                LANGSUNG KE DATABASE
              </span>
            </div>

            {/* Langkah 1: Scan QR Code */}
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-extrabold text-slate-800 flex items-center gap-1.5">
                  <QrCode className="w-4 h-4 text-blue-600" />
                  <span>1. Scan QR Code Kantor</span>
                </span>
                {qrVerified && (
                  <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> QR Valid
                  </span>
                )}
              </div>

              {!qrCameraOn ? (
                <button
                  type="button"
                  onClick={startQrScanner}
                  className="w-full py-2.5 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs flex items-center justify-center gap-2"
                >
                  <QrCode className="w-4 h-4" />
                  <span>Buka Kamera Scan QR</span>
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="w-48 h-48 mx-auto rounded-xl overflow-hidden bg-black border-2 border-blue-600">
                    <video
                      ref={qrVideoRef}
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={stopQrCamera}
                    className="w-full py-2 rounded-xl bg-rose-600 text-white text-xs font-bold"
                  >
                    Tutup Kamera QR
                  </button>
                </div>
              )}

              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Hasil scan / ketik kode QR kantor..."
                  value={qrCodeInput}
                  onChange={(e) => {
                    const val = e.target.value;
                    setQrCodeInput(val);
                    setQrVerified(
                      val.trim().toUpperCase() ===
                        officeQrCode.trim().toUpperCase()
                    );
                  }}
                  className="flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (!verifyQrValue(qrCodeInput)) {
                      showToast("err", "Kode QR tidak sesuai.");
                    }
                  }}
                  className="px-3.5 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold"
                >
                  Cek QR
                </button>
              </div>
            </div>

            {/* Langkah 2: Foto Selfie Pendeteksi Wajah */}
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-extrabold text-slate-800 flex items-center gap-1.5">
                  <Camera className="w-4 h-4 text-emerald-600" />
                  <span>2. Foto Selfie Pendeteksi Wajah</span>
                </span>
                {capturedSelfie && (
                  <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                    Selfie Siap
                  </span>
                )}
              </div>

              <p
                className={`text-[11px] font-semibold ${
                  faceStatus === "detected"
                    ? "text-emerald-700"
                    : faceStatus === "no_face"
                    ? "text-rose-600"
                    : "text-slate-600"
                }`}
              >
                {faceMessage}
              </p>

              {selfieCameraOn && (
                <div className="space-y-2">
                  <div className="w-52 h-52 mx-auto rounded-2xl overflow-hidden bg-black border-2 border-emerald-500">
                    <video
                      ref={selfieVideoRef}
                      playsInline
                      muted
                      className="w-full h-full object-cover scale-x-[-1]"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={captureSelfiePhoto}
                      className="py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-bold"
                    >
                      Ambil Selfie
                    </button>
                    <button
                      type="button"
                      onClick={stopSelfieCamera}
                      className="py-2.5 rounded-xl bg-slate-200 text-slate-800 text-xs font-bold"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              )}

              {!selfieCameraOn && (
                <button
                  type="button"
                  onClick={startSelfieCamera}
                  className="w-full py-2.5 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs flex items-center justify-center gap-2"
                >
                  <Camera className="w-4 h-4" />
                  <span>
                    {capturedSelfie
                      ? "Ambil Ulang Selfie Wajah"
                      : "Buka Kamera Selfie Wajah"}
                  </span>
                </button>
              )}

              {capturedSelfie && !selfieCameraOn && (
                <div className="flex items-center gap-3 pt-1">
                  <img
                    src={capturedSelfie}
                    alt="Hasil Selfie Wajah"
                    className="w-16 h-16 rounded-xl object-cover border-2 border-emerald-500"
                  />
                  <div className="text-xs text-emerald-800 font-semibold">
                    Selfie wajah tersimpan. Silakan tekan tombol Absen Masuk atau
                    Absen Keluar.
                  </div>
                </div>
              )}

              <canvas ref={selfieCanvasRef} className="hidden" />
            </div>

            {/* Tombol Utama: Hanya Absen Masuk & Absen Keluar */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => handleAbsenSubmit("CLOCK_IN")}
                className="py-4 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-extrabold text-xs sm:text-sm tracking-wide shadow"
              >
                + ABSEN MASUK SEKARANG
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => handleAbsenSubmit("CLOCK_OUT")}
                className="py-4 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-60 text-white font-extrabold text-xs sm:text-sm tracking-wide shadow"
              >
                + ABSEN KELUAR SEKARANG
              </button>
            </div>

            {/* Log Singkat Absensi Masuk/Keluar Milik Karyawan */}
            <div className="pt-2 border-t border-slate-100 space-y-1.5">
              <div className="text-[11px] font-bold text-slate-500 uppercase">
                Riwayat Absen Masuk/Keluar Terakhir
              </div>
              {myRecentEntries.length === 0 ? (
                <div className="text-xs text-slate-400">
                  Belum ada catatan absen hari ini.
                </div>
              ) : (
                myRecentEntries.map((row, i) => (
                  <div
                    key={`${row.client_uuid}-${i}`}
                    className="flex items-center justify-between text-xs bg-slate-50 px-3 py-2 rounded-lg"
                  >
                    <span className="font-bold text-slate-800">
                      {row.entry_type === "CLOCK_IN"
                        ? "ABSEN MASUK"
                        : "ABSEN KELUAR"}
                    </span>
                    <span className="text-slate-600 font-medium">
                      {formatTimeWIB(row.punched_at)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
