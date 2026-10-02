import { useEffect, useRef, useState } from 'react';

const INTRO_DURATION = 4400;
const EXIT_DURATION = 900;
const VARIANTS = ['bloom', 'prism', 'assembly'];

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function pickVariant() {
  if (typeof window === 'undefined') return VARIANTS[0];

  const forcedVariant = new URLSearchParams(window.location.search).get('splash');
  if (VARIANTS.includes(forcedVariant)) return forcedVariant;

  if (window.crypto?.getRandomValues) {
    const random = new Uint32Array(1);
    window.crypto.getRandomValues(random);
    return VARIANTS[random[0] % VARIANTS.length];
  }

  return VARIANTS[Math.floor(Math.random() * VARIANTS.length)];
}

function BloomScene() {
  return (
    <>
      <div className="lattice-launch__bloom-grid" aria-hidden="true" />
      <div className="lattice-launch__bloom-aura" aria-hidden="true" />
      <div className="lattice-launch__bloom-cell" aria-hidden="true" />
      <div className="lattice-launch__bloom-cell lattice-launch__bloom-cell--two" aria-hidden="true" />
      <div className="lattice-launch__bloom-cell lattice-launch__bloom-cell--three" aria-hidden="true" />
      {Array.from({ length: 6 }, (_, index) => (
        <span className="lattice-launch__bloom-ray" key={index} aria-hidden="true" />
      ))}
    </>
  );
}

function PrismScene() {
  return (
    <>
      <div className="lattice-launch__prism-beam lattice-launch__prism-beam--cyan" aria-hidden="true" />
      <div className="lattice-launch__prism-beam lattice-launch__prism-beam--coral" aria-hidden="true" />
      <div className="lattice-launch__prism-plane" aria-hidden="true" />
      <div className="lattice-launch__prism-plane lattice-launch__prism-plane--back" aria-hidden="true" />
      <div className="lattice-launch__prism-plane lattice-launch__prism-plane--side" aria-hidden="true" />
      <div className="lattice-launch__prism-orbit" aria-hidden="true" />
      <div className="lattice-launch__prism-orbit lattice-launch__prism-orbit--two" aria-hidden="true" />
      <span className="lattice-launch__prism-particle lattice-launch__prism-particle--a" aria-hidden="true" />
      <span className="lattice-launch__prism-particle lattice-launch__prism-particle--b" aria-hidden="true" />
      <span className="lattice-launch__prism-particle lattice-launch__prism-particle--c" aria-hidden="true" />
    </>
  );
}

function AssemblyScene() {
  return (
    <>
      <div className="lattice-launch__assembly-grid" aria-hidden="true" />
      <div className="lattice-launch__assembly-rail lattice-launch__assembly-rail--horizontal" aria-hidden="true" />
      <div className="lattice-launch__assembly-rail lattice-launch__assembly-rail--vertical" aria-hidden="true" />
      {Array.from({ length: 4 }, (_, index) => (
        <div className={`lattice-launch__assembly-tile lattice-launch__assembly-tile--${index + 1}`} key={index} aria-hidden="true" />
      ))}
      {Array.from({ length: 4 }, (_, index) => (
        <span className={`lattice-launch__assembly-node lattice-launch__assembly-node--${index + 1}`} key={index} aria-hidden="true" />
      ))}
    </>
  );
}

function SceneForVariant({ variant }) {
  if (variant === 'prism') return <PrismScene />;
  if (variant === 'assembly') return <AssemblyScene />;
  return <BloomScene />;
}

export default function StartupSplash({ ready, connectionDown, loading }) {
  const startedAtRef = useRef(Date.now());
  const [variant] = useState(pickVariant);
  const [leaving, setLeaving] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!ready) return undefined;

    const minimumDuration = prefersReducedMotion() ? 320 : INTRO_DURATION;
    const elapsed = Date.now() - startedAtRef.current;
    const leaveTimer = window.setTimeout(
      () => setLeaving(true),
      Math.max(0, minimumDuration - elapsed),
    );
    return () => window.clearTimeout(leaveTimer);
  }, [ready]);

  useEffect(() => {
    if (!leaving) return undefined;
    const removeTimer = window.setTimeout(
      () => setVisible(false),
      prefersReducedMotion() ? 60 : EXIT_DURATION,
    );
    return () => window.clearTimeout(removeTimer);
  }, [leaving]);

  if (!visible) return null;

  const status = connectionDown
    ? '正在等待本地服务响应'
    : ready
      ? '工作区已就绪'
      : loading
        ? '正在唤醒本地工作区'
        : '正在整理本地知识网络';
  const statusTone = connectionDown ? 'offline' : ready ? 'ready' : 'loading';

  return (
    <section
      className={`startup-splash lattice-launch lattice-launch--${variant} lattice-launch--${statusTone}${leaving ? ' lattice-launch--leaving' : ''}`}
      data-variant={variant}
      aria-label="正在启动 Lattice"
      aria-live="polite"
    >
      <div className="lattice-launch__backdrop" aria-hidden="true" />
      <div className="lattice-launch__grain" aria-hidden="true" />

      <header className="lattice-launch__header" aria-hidden="true">
        <span className="lattice-launch__header-copy">LATTICE / PRIVATE KNOWLEDGE SPACE</span>
        <span className="lattice-launch__header-phase">STARTUP / {variant.toUpperCase()}</span>
      </header>

      <div className="lattice-launch__stage">
        <div className="lattice-launch__scene">
          <SceneForVariant variant={variant} />
          <div className="lattice-launch__mark" aria-hidden="true">
            <img src="/lattice-icon.svg" alt="" />
            <span className="lattice-launch__mark-glint" />
          </div>
        </div>

        <div className="lattice-launch__lockup">
          <span className="lattice-launch__kicker">LOCAL KNOWLEDGE / PERSONAL SPACE</span>
          <h1>Lattice</h1>
          <span className="lattice-launch__rule" aria-hidden="true" />
        </div>

        <div className="lattice-launch__status" data-tone={statusTone}>
          <span className="lattice-launch__status-dot" aria-hidden="true" />
          <span>{status}</span>
        </div>
      </div>

      <footer className="lattice-launch__footer" aria-hidden="true">
        <span>MAKE SPACE FOR THOUGHT</span>
        <span>© LATTICE / LOCAL FIRST</span>
      </footer>
    </section>
  );
}
