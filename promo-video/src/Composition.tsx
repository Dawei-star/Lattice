import React from "react";
import { Composition, Folder } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { CanvasAiScene } from "./scenes/CanvasAiScene";
import { ClosingScene } from "./scenes/ClosingScene";
import { GraphScene } from "./scenes/GraphScene";
import { GithubPageTurnScene } from "./scenes/GithubPageTurnScene";
import { LocalFirstScene } from "./scenes/LocalFirstScene";
import { OpeningScene } from "./scenes/OpeningScene";

export const FPS = 30;
export const TRANSITION_FRAMES = 12;
export const SCENE_DURATIONS = {
  bookIntro: 84,
  opening: 90,
  localFirst: 110,
  graph: 110,
  canvasAi: 110,
  closing: 100,
} as const;

export const PROMO_DURATION =
  SCENE_DURATIONS.bookIntro +
  SCENE_DURATIONS.opening +
  SCENE_DURATIONS.localFirst +
  SCENE_DURATIONS.graph +
  SCENE_DURATIONS.canvasAi +
  SCENE_DURATIONS.closing -
  TRANSITION_FRAMES * 5;

export const LatticePromo: React.FC = () => (
  <TransitionSeries>
    <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS.bookIntro} name="BookIntro">
      <GithubPageTurnScene />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })} />
    <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS.opening} name="Opening">
      <OpeningScene />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })} />
    <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS.localFirst} name="LocalFirst">
      <LocalFirstScene />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={slide({ direction: "from-right" })} timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })} />
    <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS.graph} name="Graph">
      <GraphScene />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })} />
    <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS.canvasAi} name="CanvasAndAI">
      <CanvasAiScene />
    </TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={slide({ direction: "from-bottom" })} timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })} />
    <TransitionSeries.Sequence durationInFrames={SCENE_DURATIONS.closing} name="Closing">
      <ClosingScene />
    </TransitionSeries.Sequence>
  </TransitionSeries>
);

export const MyComposition: React.FC = () => (
  <>
    <Folder name="Lattice-Promo">
      <Composition id="BookIntro" component={GithubPageTurnScene} durationInFrames={SCENE_DURATIONS.bookIntro} fps={FPS} width={1920} height={1080} />
      <Composition id="Opening" component={OpeningScene} durationInFrames={SCENE_DURATIONS.opening} fps={FPS} width={1920} height={1080} />
      <Composition id="LocalFirst" component={LocalFirstScene} durationInFrames={SCENE_DURATIONS.localFirst} fps={FPS} width={1920} height={1080} />
      <Composition id="Graph" component={GraphScene} durationInFrames={SCENE_DURATIONS.graph} fps={FPS} width={1920} height={1080} />
      <Composition id="CanvasAndAI" component={CanvasAiScene} durationInFrames={SCENE_DURATIONS.canvasAi} fps={FPS} width={1920} height={1080} />
      <Composition id="Closing" component={ClosingScene} durationInFrames={SCENE_DURATIONS.closing} fps={FPS} width={1920} height={1080} />
    </Folder>
    <Composition id="LatticePromo" component={LatticePromo} durationInFrames={PROMO_DURATION} fps={FPS} width={1920} height={1080} />
  </>
);
