import React, { PropsWithChildren } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export const COLORS = {
  ink: "#050a2b",
  navy: "#0b1350",
  blue: "#3b50df",
  cobalt: "#6f86f0",
  ice: "#c6d6ff",
  white: "#f5f8ff",
  muted: "#aab9e9",
};

export const FONT = "Microsoft YaHei, Segoe UI, sans-serif";

export const ease = Easing.bezier(0.16, 1, 0.3, 1);

export const reveal = (frame: number, start: number, distance = 34) => ({
  opacity: interpolate(frame, [start, start + 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  }),
  translate: `0px ${interpolate(frame, [start, start + 18], [distance, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  })}px`,
});

export const fade = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

export const BrandMark: React.FC<{
  size?: number;
  glow?: boolean;
  style?: React.CSSProperties;
}> = ({ size = 68, glow = false, style }) => (
  <Img
    src={staticFile("assets/lattice-icon.svg")}
    style={{
      width: size,
      height: size,
      objectFit: "contain",
      filter: glow ? "drop-shadow(0 0 24px rgba(111, 134, 240, 0.65))" : undefined,
      ...style,
    }}
  />
);

export const SceneFrame: React.FC<
  PropsWithChildren<{ eyebrow?: string; index: string }>
> = ({ children, eyebrow = "LATTICE / LOCAL KNOWLEDGE", index }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.ink,
        color: COLORS.white,
        fontFamily: FONT,
        overflow: "hidden",
      }}
    >
      <AbsoluteFill
        style={{
          opacity: 0.32,
          backgroundImage:
            "linear-gradient(rgba(198,214,255,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(198,214,255,0.07) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          backgroundPosition: `${-frame * 0.16}px ${-frame * 0.08}px`,
          maskImage: "linear-gradient(to bottom, black, transparent 92%)",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(118deg, rgba(6,10,36,0.98) 0%, rgba(13,20,82,0.82) 54%, rgba(6,10,36,0.98) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          top: 44,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          zIndex: 5,
          fontSize: 14,
          letterSpacing: 2.4,
          color: COLORS.muted,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <BrandMark size={28} />
          <span>{eyebrow}</span>
        </div>
        <span style={{ color: COLORS.ice }}>{index}</span>
      </div>
      <div
        style={{
          position: "absolute",
          top: height * 0.12,
          right: width * 0.07,
          width: 1,
          height: height * 0.72,
          background: "linear-gradient(to bottom, transparent, rgba(198,214,255,0.36), transparent)",
          opacity: 0.5,
        }}
      />
      {children}
    </AbsoluteFill>
  );
};

export const Label: React.FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = COLORS.cobalt,
}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      color,
      fontSize: 15,
      letterSpacing: 2.2,
      fontWeight: 600,
      textTransform: "uppercase",
    }}
  >
    <span style={{ width: 28, height: 1, backgroundColor: color }} />
    {children}
  </div>
);

export const Pill: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      padding: "11px 16px",
      border: "1px solid rgba(198,214,255,0.24)",
      borderRadius: 999,
      backgroundColor: "rgba(198,214,255,0.06)",
      color: COLORS.ice,
      fontSize: 15,
      letterSpacing: 0.5,
    }}
  >
    {children}
  </div>
);

export const ProductWindow: React.FC<{
  src: string;
  width: number;
  height: number;
  style?: React.CSSProperties;
  scale?: number;
}> = ({ src, width, height, style, scale = 1 }) => {
  const frame = useCurrentFrame();
  const shine = interpolate(frame, [0, 90], [-18, 118], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        width,
        height,
        scale,
        borderRadius: 22,
        overflow: "hidden",
        backgroundColor: "#101a55",
        border: "1px solid rgba(198,214,255,0.38)",
        boxShadow: "0 28px 70px rgba(1, 4, 22, 0.56), 0 0 0 1px rgba(111,134,240,0.14)",
        ...style,
      }}
    >
      <div
        style={{
          height: 34,
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "0 14px",
          backgroundColor: "rgba(5,10,43,0.92)",
          borderBottom: "1px solid rgba(198,214,255,0.16)",
        }}
      >
        {["#ff8a9c", "#ffcf71", "#77d9b4"].map((color) => (
          <span key={color} style={{ width: 7, height: 7, borderRadius: 99, backgroundColor: color }} />
        ))}
        <span style={{ marginLeft: 8, color: COLORS.muted, fontSize: 11, letterSpacing: 1.5 }}>
          LATTICE / VAULT
        </span>
      </div>
      <div style={{ position: "relative", width: "100%", height: height - 34 }}>
        <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            width: 160,
            left: `${shine}%`,
            opacity: 0.22,
            transform: "skewX(-20deg)",
            background: "linear-gradient(90deg, transparent, rgba(198,214,255,0.7), transparent)",
          }}
        />
      </div>
    </div>
  );
};

export const CornerBracket: React.FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = COLORS.cobalt,
}) => (
  <div
    style={{
      position: "relative",
      padding: "22px 26px",
      borderLeft: `1px solid ${color}`,
      borderTop: `1px solid ${color}`,
      borderBottom: `1px solid rgba(111,134,240,0.2)`,
      borderRight: `1px solid rgba(111,134,240,0.2)`,
      backgroundColor: "rgba(198,214,255,0.04)",
      boxShadow: "inset 0 0 28px rgba(111,134,240,0.06)",
    }}
  >
    <div style={{ position: "absolute", right: -1, bottom: -1, width: 28, height: 1, backgroundColor: color }} />
    <div style={{ position: "absolute", right: -1, bottom: -1, width: 1, height: 28, backgroundColor: color }} />
    {children}
  </div>
);

