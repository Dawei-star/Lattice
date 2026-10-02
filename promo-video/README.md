# Lattice Promo

An editable Remotion promo film for Lattice.

## Preview

```bash
npm install
npx remotion studio --no-open
```

Open `http://localhost:3000/LatticePromo` in Remotion Studio.

## Structure

- `src/scenes/GithubPageTurnScene.tsx`: GitHub repository page turning into the Lattice opener
- `src/scenes/OpeningScene.tsx`: brand introduction and product workspace
- `src/scenes/LocalFirstScene.tsx`: local-first storage and privacy
- `src/scenes/GraphScene.tsx`: bidirectional knowledge graph
- `src/scenes/CanvasAiScene.tsx`: Canvas and AI assistant
- `src/scenes/ClosingScene.tsx`: logo lockup and product CTA

The `LatticePromo` composition is 1920x1080, 30fps, and 544 frames (18.13 seconds). Individual scenes are registered under the `Lattice-Promo` folder for direct timeline editing.
