CREATE TABLE IF NOT EXISTS karyawan (
  id_karyawan VARCHAR(50) PRIMARY KEY,
  nama VARCHAR(100) NOT NULL,
  pin VARCHAR(20) NOT NULL,
  role VARCHAR(20) DEFAULT 'karyawan'
);

CREATE TABLE IF NOT EXISTS jadwal_keberangkatan (
  id_karyawan VARCHAR(50) NOT NULL,
  nama VARCHAR(100) NOT NULL,
  tanggal DATE NOT NULL,
  jam_berangkat VARCHAR(10) NOT NULL,
  jam_pulang VARCHAR(10) DEFAULT '17:00',
  toleransi_menit INT DEFAULT 10,
  lat DOUBLE PRECISION DEFAULT -6.914744,
  lng DOUBLE PRECISION DEFAULT 109.712890,
  radius_meter INT DEFAULT 150,
  PRIMARY KEY (id_karyawan, tanggal)
);

CREATE TABLE IF NOT EXISTS log_absensi (
  id_log VARCHAR(100) PRIMARY KEY,
  tanggal DATE NOT NULL,
  id_karyawan VARCHAR(50) NOT NULL,
  nama VARCHAR(100) NOT NULL,
  jenis VARCHAR(20) NOT NULL,
  waktu_scan VARCHAR(10) NOT NULL,
  jadwal_berangkat VARCHAR(10) NOT NULL,
  telat_menit INT DEFAULT 0,
  status VARCHAR(30) NOT NULL,
  koordinat_gps VARCHAR(60),
  jarak_meter INT DEFAULT 0,
  mode_rekam VARCHAR(20) DEFAULT 'Online',
  qr_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO karyawan (id_karyawan, nama, pin, role) VALUES
('ADM-001', 'Administrator Utama', '9999', 'admin'),
('KRY-001', 'Budi Santoso', '1234', 'karyawan')
ON CONFLICT (id_karyawan) DO NOTHING;
