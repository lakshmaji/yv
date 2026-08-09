// Command dmg-background draws the backdrop for the macOS disk image window.
//
// It exists because there is no scriptable image tool on a stock macOS that can
// draw one — sips only transforms an image that already exists — and the
// alternative is committing a binary nobody in the repo can regenerate or
// review. Fifty lines of stdlib is a smaller dependency than that.
//
// Run via `make dmg-background`. The PNG it writes *is* committed, so an
// ordinary `make dmg` never depends on this having been run.
//
// The output is exactly the window size create-dmg is told to use
// (build/darwin/package-dmg.sh). Finder tiles a background that does not match,
// so the two numbers are one fact in two files and drifting them is visible
// immediately — the arrow appears twice.
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
)

const (
	width  = 600
	height = 400

	// The icon centres, from package-dmg.sh. The arrow lives in the gap
	// between the two 128px icons: they span roughly x=86..214 and x=386..514,
	// so it starts and ends well inside that.
	arrowFrom = 250.0
	arrowTo   = 350.0
	arrowY    = 205.0
)

// The app's own background family, so the disk image window reads as the same
// piece of software the user is about to install rather than as a stock
// installer that happens to contain it.
var (
	top    = color.RGBA{0x0d, 0x11, 0x17, 0xff}
	bottom = color.RGBA{0x16, 0x1b, 0x22, 0xff}
	ink    = color.RGBA{0x3d, 0x44, 0x4d, 0xff}
)

func main() {
	out := "build/darwin/dmg-background.png"
	if len(os.Args) > 1 {
		out = os.Args[1]
	}
	if err := write(out); err != nil {
		fmt.Fprintf(os.Stderr, "dmg-background: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("\n  Wrote %s (%dx%d)\n\n", out, width, height)
}

func write(path string) error {
	img := image.NewRGBA(image.Rect(0, 0, width, height))

	for y := 0; y < height; y++ {
		row := lerp(top, bottom, float64(y)/float64(height-1))
		for x := 0; x < width; x++ {
			img.SetRGBA(x, y, row)
		}
	}
	drawArrow(img)

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		return err
	}
	return f.Close()
}

// drawArrow paints a chevron pointing from the app icon at the Applications
// alias — the whole instruction the window has to give, and the one thing a
// first-time user needs told.
func drawArrow(img *image.RGBA) {
	// Shaft, then the two strokes of the head. A single polygon fill would
	// need winding rules for a shape this simple; three thick segments is the
	// same picture with none of that.
	type seg struct{ ax, ay, bx, by, half float64 }
	segs := []seg{
		{arrowFrom, arrowY, arrowTo, arrowY, 2},
		{arrowTo - 18, arrowY - 18, arrowTo, arrowY, 2},
		{arrowTo - 18, arrowY + 18, arrowTo, arrowY, 2},
	}

	// Coverage from the distance to the nearest segment rather than plain
	// on/off: at this size an aliased arrow reads as a jagged artefact of the
	// background image, not as a drawn mark.
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			d := math.Inf(1)
			for _, s := range segs {
				d = math.Min(d, distToSegment(float64(x)+0.5, float64(y)+0.5, s.ax, s.ay, s.bx, s.by)-s.half)
			}
			cov := clamp(0.5-d, 0, 1)
			if cov <= 0 {
				continue
			}
			img.SetRGBA(x, y, lerp(img.RGBAAt(x, y), ink, cov))
		}
	}
}

func distToSegment(px, py, ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	length := dx*dx + dy*dy
	t := 0.0
	if length > 0 {
		t = clamp(((px-ax)*dx+(py-ay)*dy)/length, 0, 1)
	}
	return math.Hypot(px-(ax+t*dx), py-(ay+t*dy))
}

func lerp(a, b color.RGBA, t float64) color.RGBA {
	mix := func(x, y uint8) uint8 { return uint8(math.Round(float64(x) + (float64(y)-float64(x))*t)) }
	return color.RGBA{mix(a.R, b.R), mix(a.G, b.G), mix(a.B, b.B), 0xff}
}

func clamp(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, v))
}
