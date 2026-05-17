# Apex Notes UI Styleguide

Source: https://apex-notes.netlify.app/

This guide translates the public Apex Notes website into product UI rules for the local desktop app. The goal is to borrow the website's quiet beauty, warmth, and confidence while keeping the app dense, fast, and useful for repeated work.

## Design Direction

Apex Notes should feel like a focused thinking instrument: dark, calm, precise, and slightly luminous. The website is not loud. Its beauty comes from restraint: a warm black canvas, bone-white text, muted secondary copy, crisp borders, generous spacing, and one memorable accent.

For the app, keep the same emotional temperature but reduce the landing-page scale. The graph and editor are the product. They should feel crafted, not decorated.

## Core Principles

1. Keep the workspace quiet.
   The app is for reading, connecting, dragging, editing, and scanning notes. Avoid decorative panels, gradients, floating cards, background art, and marketing-style sections.

2. Use warmth instead of pure grayscale.
   The website palette is not blue-black or slate. It uses warm near-black, ivory text, and soft gray-brown borders. Product surfaces should follow that warmth.

3. Make hierarchy visible through spacing and weight.
   Use size, weight, alignment, and borders before adding more color. The interface should be easy to parse in peripheral vision.

4. Keep accents rare and meaningful.
   The website's chartreuse accent is powerful because it is used sparingly. In the app, reserve it for primary actions, active confirmations, strong focus states, and selected high-priority UI.

5. Let graph color remain functional.
   The graph may keep distinct node/edge colors for levels, wiki links, missing links, and temporary ropes. These colors should be tuned to sit inside the warmer website palette rather than becoming the whole brand.

## Color System

Use these website-derived tokens as the product baseline:

```css
:root {
  color-scheme: dark;
  --bg: #11110f;
  --surface: #191916;
  --fg: #f1eee6;
  --muted: #aaa49a;
  --line: #34322d;
  --accent: #d8ef8e;
  --accent-ink: #14150f;
}
```

Recommended app expansions:

```css
:root {
  --bg-raised: #1f1f1b;
  --line-soft: rgba(241, 238, 230, 0.12);
  --line-strong: rgba(241, 238, 230, 0.28);
  --focus-ring: 0 0 0 2px rgba(216, 239, 142, 0.28);
  --danger: #ff7896;
  --reference: #9fc5ff;
  --missing: #ffb6d1;
  --rope: #b88cff;
}
```

Usage:

- `--bg` is the full app canvas.
- `--surface` is for buttons, tabs, dialogs, and shallow tool surfaces.
- `--bg-raised` is for hovered surfaces and subtle elevation.
- `--fg` is primary text and active borders.
- `--muted` is secondary text, metadata, placeholders, and inactive labels.
- `--line` is the default separator and product-frame border.
- `--accent` is the primary action and strongest selected/focus state.
- `--reference`, `--missing`, and `--rope` are graph/editor semantics, not brand accents.

Avoid:

- Pure black as the only background.
- Large purple, blue, or slate regions.
- Gradients, glow fields, bokeh, or decorative blur.
- Too many simultaneous accent colors in chrome UI.

## Typography

Use the website's system sans stack:

```css
font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
letter-spacing: 0;
```

Product type scale:

- App title / selected note title: 18px, 640-700 weight.
- Pane titles: 13px to 14px, 650 weight.
- Body/editor text: 14.5px to 16px depending on density.
- Labels, metadata, status text: 11px to 12px.
- Buttons: 13px to 14px, 620-680 weight.

Rules:

- Do not use website-scale hero typography inside the app.
- Keep letter spacing at `0`, except optional uppercase eyebrow labels.
- Use truncation deliberately for paths, tab names, and selected note titles.
- Never let button text wrap awkwardly inside compact controls.

## Layout

The website uses a two-column hero with generous padding. The app should translate that into clear panes and honest spacing:

- Top-level panes use single-pixel borders.
- Toolbars should be compact, about 42px to 56px tall.
- Primary app layouts should align to an 8px rhythm.
- Dense controls may use 4px gaps where the grouping is obvious.
- Dialogs and popovers should use 12px to 16px internal padding.
- Avoid cards inside cards. Use pane boundaries, rows, and grouped controls instead.

The graph should keep the largest share of the viewport. The editor should feel like a stable sidecar, not a competing hero surface.

## Shape And Borders

Website shapes:

- App icon: 18px radius.
- Buttons and preview image: 8px radius.
- Product app controls can stay tighter.

Product rules:

- Default control radius: 4px.
- Larger dialog/popover radius: 6px to 8px.
- Icon buttons may be square with 4px radius.
- Circular controls are only for tiny affordances like help or close buttons.
- Use `1px` borders for structure. Do not rely on heavy shadows for everyday panes.

## Buttons And Controls

Primary button:

```css
.primaryAction {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 680;
}
```

Secondary button:

```css
.secondaryAction {
  border-color: var(--line);
  background: var(--surface);
  color: var(--fg);
}
```

Interaction rules:

- Primary actions should be rare: create, confirm, save/export, or start a key flow.
- Secondary actions should stay low-contrast until hover/focus.
- Hover should clarify, not animate theatrically.
- Focus states should be visible and warm, using the accent ring.
- Disabled states should reduce opacity and preserve layout dimensions.

Use icon buttons for repeated tools such as zoom, close, delete, fullscreen, and reset when the icon is familiar. Pair unfamiliar icons with tooltips or accessible labels.

## Graph Styling

The graph is the soul of the product. It should feel like the website preview: a dark field with fine-line structure and readable connected notes.

Graph rules:

- Keep the graph background warm near-black.
- Use thin hierarchy edges with rounded caps.
- Use dotted reference edges for body `[[wiki links]]`.
- Keep loose nodes visibly different but not alarming.
- Keep selected nodes clear through fill, weight, and a controlled glow.
- Use purple only for temporary connection mechanics, such as the rope.
- Use blue for contextual references and pink for missing references only.

Labels:

- Default labels should be compact and crisp.
- Show labels on hover, focus, selection, search match, or important zoom thresholds.
- Do not let labels crowd the whole canvas when zoomed out.

Motion:

- Use motion for causality: dragging, rope flow, selection, fitting view.
- Keep transitions under 180ms unless the action is spatial and benefits from easing.
- Prefer `cubic-bezier(0.22, 1, 0.36, 1)` for soft settling.

## Editor Styling

The editor should feel native to the graph, not like a separate document app pasted beside it.

- Use the same warm background as the graph.
- Keep the note title compact and truncated in the pane header.
- Use muted metadata for paths and save/status messages.
- Make wiki links colorful and underlined enough to be discoverable.
- Missing wiki links can use pink, but avoid making them look like errors unless action is required.
- Keep frontmatter editing clear and stable; hierarchy fields are product-critical.

## Dialogs And Popovers

Dialogs should feel grounded and minimal:

- Background: `--bg` or a slightly raised surface.
- Border: `--line-strong`.
- Radius: 6px to 8px.
- Shadow: only for overlays, not everyday panes.
- Backdrop: dark translucent black with subtle blur.
- Width: narrow by default, wider only for long prompts or help content.

Dialog copy should be direct and sparse. Avoid explaining the whole app inside dialogs unless the dialog is explicitly help-oriented.

## Website-To-App Translation

Keep from the website:

- Warm dark palette.
- Ivory text.
- Muted gray-brown secondary text.
- Chartreuse primary action.
- Simple borders.
- Strong confidence through restraint.
- Product screenshot feeling: real interface, not illustration.

Do not copy from the website:

- Hero-scale typography.
- Landing-page vertical sections.
- Large CTA stacks inside the workspace.
- Marketing copy inside product chrome.
- Big preview-card framing around the graph.

## Implementation Checklist

Before merging UI work:

- Colors use the warm website palette as the default.
- The graph remains the dominant surface.
- Primary accent appears only where it communicates action or state.
- Controls have stable dimensions and do not shift on hover.
- Focus states are visible from keyboard navigation.
- Text does not overlap, wrap poorly, or disappear at small widths.
- Mobile/narrow layouts preserve the same visual hierarchy.
- Graph semantics remain distinct: hierarchy, references, missing links, loose nodes, and active rope.
- No private or user-specific notes are added to the bundled `notes/` folder.

## North Star

The website says: "Apex Notes is beautiful because it is serious about one thing."

The app should say the same thing every time someone opens a folder.
