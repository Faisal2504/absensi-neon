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
