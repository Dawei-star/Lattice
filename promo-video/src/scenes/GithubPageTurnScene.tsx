import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { BrandMark, COLORS, FONT, Label, reveal } from "../components/Shared";

export const GithubPageTurnScene: React.FC = () => {
  const frame = useCurrentFrame();
  const rotation = interpolate(frame, [14, 70], [0, -178], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const pageOpacity = interpolate(frame, [0, 8, 72, 84], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const backOpacity = interpolate(frame, [42, 78], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const shadowOpacity = interpolate(frame, [14, 70], [0.48, 0.08], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.ink,
        color: COLORS.white,
        fontFamily: FONT,
        overflow: "hidden",
        perspective: 1800,
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage:
            "linear-gradient(rgba(198,214,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(198,214,255,0.06) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          opacity: 0.42,
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
          color: COLORS.muted,
          fontSize: 14,
          letterSpacing: 2.4,
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <BrandMark size={28} />
          <span>LATTICE / OPEN SOURCE</span>
        </div>
        <span style={{ color: COLORS.ice }}>00 / 06</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 250,
          top: 150,
          width: 1420,
          height: 770,
          transformStyle: "preserve-3d",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 18,
            border: "1px solid rgba(198,214,255,0.32)",
            background: "linear-gradient(135deg, #0c1557, #111e73 56%, #060a24)",
            opacity: backOpacity,
            boxShadow: "0 24px 80px rgba(0,0,0,0.42)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <BrandMark size={132} glow />
            <div style={{ fontSize: 72, fontWeight: 700, letterSpacing: -2, marginTop: 24 }}>Lattice</div>
            <Label color={COLORS.ice}>Open source / local AI knowledge</Label>
            <div style={{ color: COLORS.muted, fontSize: 21, marginTop: 28 }}>你的知识库，由你掌握。</div>
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: pageOpacity,
            transformOrigin: "left center",
            transform: `rotateY(${rotation}deg)`,
            transformStyle: "preserve-3d",
            backfaceVisibility: "hidden",
            borderRadius: 18,
            overflow: "hidden",
            backgroundColor: "#ffffff",
            border: "1px solid rgba(198,214,255,0.55)",
            boxShadow: `0 35px 90px rgba(1, 3, 18, ${shadowOpacity}), 14px 0 0 rgba(111,134,240,0.16)`,
          }}
        >
          <div style={{ height: 38, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", backgroundColor: "#f6f8fb", borderBottom: "1px solid #dce2eb" }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, backgroundColor: "#ff6d77" }} />
            <span style={{ width: 8, height: 8, borderRadius: 99, backgroundColor: "#ffc862" }} />
            <span style={{ width: 8, height: 8, borderRadius: 99, backgroundColor: "#69c891" }} />
            <span style={{ marginLeft: 10, color: "#7a8597", fontSize: 12, letterSpacing: 1.2 }}>github.com / Dawei-star / Lattice</span>
          </div>
          <Img src={staticFile("assets/github-repo-page.png")} style={{ width: "100%", height: "calc(100% - 38px)", objectFit: "cover", objectPosition: "center top" }} />
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(110deg, transparent 34%, rgba(255,255,255,0.28) 49%, transparent 63%)", translate: `${interpolate(frame, [0, 84], [-760, 760], { extrapolateRight: "clamp" })}px 0px`, pointerEvents: "none" }} />
        </div>
        <div style={{ position: "absolute", left: -1, top: 0, bottom: 0, width: 2, background: COLORS.ice, opacity: interpolate(frame, [0, 30], [0, 0.7], { extrapolateRight: "clamp" }) }} />
      </div>
      <div style={{ position: "absolute", left: 110, bottom: 92, ...reveal(frame, 56, 18), zIndex: 8 }}>
        <div style={{ color: COLORS.ice, fontSize: 13, letterSpacing: 2.1 }}>TURN THE PAGE</div>
        <div style={{ width: 250, height: 1, marginTop: 12, background: `linear-gradient(90deg, ${COLORS.ice}, transparent)` }} />
        <div style={{ color: COLORS.muted, fontSize: 16, marginTop: 14 }}>从 GitHub 开源项目，到 AI 知识助手</div>
      </div>
    </AbsoluteFill>
  );
};

