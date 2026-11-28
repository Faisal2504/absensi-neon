import { ImageResponse } from "next/og";

export const size = {
  width: 512,
  height: 512,
};

export const contentType = "image/png";

export default async function Icon({ baseUrl }: { baseUrl?: string }) {
  const origin = baseUrl || "https://absensi-neon-sage.vercel.app";
  const imgUrl = `${origin}/logo-absensi.png?v=2`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0B1220",
        }}
      >
        <img
          src={imgUrl}
          alt="Logo Absensi"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </div>
    ),
    {
      ...size,
    }
  );
}
