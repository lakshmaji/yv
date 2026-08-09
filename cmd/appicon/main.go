// Command appicon renders build/appicon.png from the artwork in
// build/appicon-source.png.
//
// build/appicon.png is the one icon in the repo: Wails derives the macOS .icns
// and the Windows .ico from it, and the Linux packaging scripts copy it
// straight into the .deb and the AppImage. So this runs once, when the artwork
// changes, and every platform follows.
//
// It exists rather than a committed crop because the source is a wide painting
// and the icon is a square with rounded corners inset in a transparent canvas —
// three decisions (which square, how much inset, what radius) that are worth
// having written down and re-runnable rather than trapped in whatever tool
// happened to be open. sips could do the first two, but not on Linux, and not
// the corners.
//
//	go run ./cmd/appicon [source.png [out.png]]
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
	// Apple's icon grid: the artwork occupies 824 of a 1024 canvas, and the
	// rest is transparent margin the system draws shadows into. A full-bleed
	// square would sit in the Dock as the one sharp rectangle among rounded
	// neighbours.
	canvas = 1024
	body   = 824
	radius = 185.0 // 0.225 × body, the Big Sur corner
)

func main() {
	src := "build/appicon-source.png"
	out := "build/appicon.png"
	if len(os.Args) > 1 {
		src = os.Args[1]
	}
	if len(os.Args) > 2 {
		out = os.Args[2]
	}
	if err := render(src, out); err != nil {
		fmt.Fprintf(os.Stderr, "appicon: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("\n  Wrote %s (%dx%d)\n\n", out, canvas, canvas)
}

func render(srcPath, outPath string) error {
	f, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer f.Close()
	art, err := png.Decode(f)
	if err != nil {
		return fmt.Errorf("%s: %w", srcPath, err)
	}

	icon := image.NewNRGBA(image.Rect(0, 0, canvas, canvas))
	square := centredSquare(art.Bounds())
	offset := (canvas - body) / 2

	for y := 0; y < body; y++ {
		for x := 0; x < body; x++ {
			// Alpha first: the corners are most of the point of this program,
			// and sampling a pixel that is about to be erased is wasted work
			// on a million-pixel image.
			a := coverage(float64(x)+0.5, float64(y)+0.5)
			if a <= 0 {
				continue
			}
			c := sample(art, square, float64(x)/body, float64(y)/body)
			c.A = uint8(math.Round(float64(c.A) * a))
			icon.SetNRGBA(offset+x, offset+y, c)
		}
	}

	w, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer w.Close()
	if err := png.Encode(w, icon); err != nil {
		return err
	}
	return w.Close()
}

// centredSquare is the largest square the artwork can give, taken from its
// middle. The subject is painted centred, so this needs no cleverness — but it
// does need saying, because the crop is what decides how much of the animal
// survives at 32px.
func centredSquare(b image.Rectangle) image.Rectangle {
	side := b.Dx()
	if b.Dy() < side {
		side = b.Dy()
	}
	x := b.Min.X + (b.Dx()-side)/2
	y := b.Min.Y + (b.Dy()-side)/2
	return image.Rect(x, y, x+side, y+side)
}

// sample reads the artwork at a normalised position, bilinearly.
//
// Nearest-neighbour is visibly wrong here: the source is smaller than the body
// it is drawn into, so every output pixel lands between source pixels and the
// neon strokes would come out with stepped edges.
func sample(src image.Image, area image.Rectangle, u, v float64) color.NRGBA {
	fx := float64(area.Min.X) + u*float64(area.Dx()-1)
	fy := float64(area.Min.Y) + v*float64(area.Dy()-1)
	x0, y0 := int(fx), int(fy)
	tx, ty := fx-float64(x0), fy-float64(y0)

	x1, y1 := x0+1, y0+1
	if x1 >= area.Max.X {
		x1 = area.Max.X - 1
	}
	if y1 >= area.Max.Y {
		y1 = area.Max.Y - 1
	}

	c00 := nrgbaAt(src, x0, y0)
	c10 := nrgbaAt(src, x1, y0)
	c01 := nrgbaAt(src, x0, y1)
	c11 := nrgbaAt(src, x1, y1)

	mix := func(a, b, c, d uint8) uint8 {
		top := float64(a) + (float64(b)-float64(a))*tx
		bot := float64(c) + (float64(d)-float64(c))*tx
		return uint8(math.Round(top + (bot-top)*ty))
	}
	return color.NRGBA{
		mix(c00.R, c10.R, c01.R, c11.R),
		mix(c00.G, c10.G, c01.G, c11.G),
		mix(c00.B, c10.B, c01.B, c11.B),
		mix(c00.A, c10.A, c01.A, c11.A),
	}
}

func nrgbaAt(src image.Image, x, y int) color.NRGBA {
	c := color.NRGBAModel.Convert(src.At(x, y))
	return c.(color.NRGBA)
}

// coverage is how much of the pixel at (x, y) falls inside the rounded square,
// as a fraction. Anti-aliased rather than a hard test: at this radius a stepped
// corner is the first thing the eye finds on an otherwise smooth shape.
func coverage(x, y float64) float64 {
	// Distance to the rounded rectangle, computed in one quadrant by folding
	// the point into it — the shape is symmetric, so the other three are the
	// same arithmetic with signs to get wrong.
	cx := math.Abs(x-body/2) - (body/2 - radius)
	cy := math.Abs(y-body/2) - (body/2 - radius)
	d := math.Min(math.Max(cx, cy), 0) + math.Hypot(math.Max(cx, 0), math.Max(cy, 0)) - radius
	return math.Max(0, math.Min(1, 0.5-d))
}
