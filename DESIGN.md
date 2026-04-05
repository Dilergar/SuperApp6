```markdown
# Design System Specification: The Digital Atelier

## 1. Overview & Creative North Star
**Creative North Star: "The Living Sketchbook"**

This design system rejects the sterile, pixel-perfect rigidity of modern SaaS platforms. Instead, it celebrates the "soul of the hand." Our goal is to create a high-fidelity digital experience that feels like a master artist’s personal sketchbook—where every stroke is intentional, and every "imperfection" is a deliberate design choice. 

We break the "template" look by utilizing intentional asymmetry, staggered layouts, and tactile depth. We aren't building a grid of boxes; we are composing a series of mixed-media pages. The interface should feel warm, personal, and premium, balancing the raw energy of charcoal and wax crayons with the sophisticated clarity of high-end editorial typography.

---

## 2. Colors: The Pigment Palette
The palette is rooted in a base of textured paper, accented by vibrant "crayon" primary tones and soft "watercolor" washes.

*   **The "No-Line" Rule:** Standard 1px solid borders are strictly prohibited for defining sections. Structure must be created through background shifts. For example, a `surface_container_low` section should sit directly on the `surface` background to define its boundaries.
*   **Surface Hierarchy & Nesting:** Treat the UI as stacked sheets of watercolor paper. Use `surface_container_lowest` (#ffffff) for the "brightest" highlights or top-most floating elements, and `surface_dim` (#e4e4d1) for recessed areas or "back pages." 
*   **Watercolor Washes:** Use `primary_container` (#ffaca3) and `secondary_container` (#c7e7ff) with a 40-60% opacity fill to create "wash" effects behind CTAs. These should not be perfect rectangles; use SVG masks to create slightly bleeding, organic edges.
*   **Wax & Charcoal Accents:** Use `primary` (#c61a1e) for bold, wax-red "drawn" accents and `on_surface` (#38392d) for charcoal-like text and sketches.

---

## 3. Typography: The Artist’s Hand
We utilize a hierarchy that mimics the difference between a bold title marker and a fine-point technical pencil.

*   **Display & Headlines (Epilogue):** This is our "Marker" style. Use `display-lg` (3.5rem) for main hero statements. The weight of Epilogue provides a bold, confident strike that mimics heavy ink.
*   **Body & Labels (Plus Jakarta Sans):** This is our "Technical Pencil." While clean and highly legible, when paired with the sketchbook background, it acts as the neat, handwritten annotations of the designer. 
*   **Editorial Intent:** Use `title-lg` for pull-quotes or emphasis. Ensure there is significant breathing room (using `spacing-12` or `spacing-16`) between headlines and body text to mimic the airy layout of an art book.

---

## 4. Elevation & Depth: Tonal Layering & Cross-Hatching
Shadows and lines in this system are analog, not algorithmic.

*   **The Cross-Hatch Principle:** Instead of standard CSS drop shadows, use a custom background pattern that mimics pencil cross-hatching for "shadowed" elements. Use the `outline_variant` token (#bbbaab) at 20% opacity to draw these diagonal lines behind cards.
*   **Ambient Lift:** For elements that must "float," use an extra-diffused shadow with a 24px-32px blur and 5% opacity, tinted with the `surface_tint` (#c61a1e) to mimic light reflecting off the warm paper.
*   **The "Ghost Border":** If a container requires a boundary, use the `outline_variant` at 15% opacity with an irregular `border-radius` (mix and match values like `0.5rem`, `1rem`, and `0.75rem` on a single element) to simulate a hand-drawn line.
*   **Glassmorphism:** Use semi-transparent `surface_container_lowest` with a `backdrop-blur` of 8px-12px for floating navigation bars, allowing the "paper texture" underneath to remain visible.

---

## 5. Components: Hand-Crafted Primitives

### Buttons
*   **Primary:** A "Watercolor Wash" using a gradient from `primary` (#c61a1e) to `primary_dim` (#b40414). The shape should have a slight "bleed" (irregular border-radius).
*   **Secondary:** A "Crayon Outline." A 2px irregular stroke using `secondary` (#326a8b) with no fill, mimicking a sky-blue wax pencil.
*   **Tertiary:** Pure text (`label-md`) with a `tertiary_container` "highlight" stroke that appears only on hover, like a yellow highlighter pen.

### Inputs & Fields
*   **Text Inputs:** Forbid 4-sided boxes. Use a single, "shaky" bottom border (2px) using the `outline` token. 
*   **Labels:** Always use `label-md` in `on_surface_variant`, positioned slightly asymmetrically above the input field.

### Cards
*   **Construction:** Use `surface_container` with a `roundedness-md` (0.75rem). 
*   **Visual Separation:** Never use divider lines. Use `spacing-6` to separate content blocks or a subtle shift to `surface_container_high` for nested content.

### Selection Controls
*   **Checkboxes:** Should look like hand-drawn "X" marks using the `primary` wax-red.
*   **Radio Buttons:** Should look like charcoal-filled circles.

---

## 6. Do's and Don'ts

### Do:
*   **Embrace Asymmetry:** Stagger images and text blocks. Use `spacing-10` on one side and `spacing-12` on the other to create a "pasted-in" feel.
*   **Use Texture:** Always ensure the `#fdffda` background has a subtle noise or paper grain overlay.
*   **Layer Surfaces:** Place `surface_container_lowest` cards on a `surface_container_low` background to create soft depth.

### Don't:
*   **Don't use 1px black borders.** This immediately breaks the artistic illusion.
*   **Don't use perfect circles.** For icons or decorative elements, use slightly warped SVG paths.
*   **Don't crowd the canvas.** High-end sketchbooks have plenty of "white space" (or in our case, "paper space"). If in doubt, increase spacing using the `spacing-8` or `spacing-12` tokens.
*   **Don't use pure grey shadows.** Always tint shadows with a hint of the `primary` or `on_surface` color to maintain warmth.

---

## 7. Director's Final Note
This system succeeds when it feels **deliberate**. Every "sketchy" line must be a high-fidelity asset. We are not making a "messy" UI; we are making a "curated" one. Use the `spacing-scale` rigorously to ensure that despite the hand-drawn aesthetic, the information architecture remains crystalline and easy to navigate.