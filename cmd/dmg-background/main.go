// Command dmg-background draws the backdrop for the macOS disk image window.
//
// It exists because there is no scriptable image tool on a stock macOS that can
// draw one — sips only transforms an image that already exists — and the
// alternative is committing a binary nobody in the repo can regenerate or
// review. A couple of hundred lines of stdlib is a smaller dependency than that.
//
// Run via `make dmg-background`. The PNG it writes *is* committed, so an
// ordinary `make dmg` never depends on this having been run.
//
// The output is exactly the window size create-dmg is told to use
// (build/darwin/package-dmg.sh). Finder tiles a background that does not match,
// so the two numbers are one fact in two files and drifting them is visible
// immediately — the arrow appears twice.
//
// # Why the colours are mid-tone and not the app's own dark palette
//
// Finder draws the two icon labels — "yv" and "Applications" — in the colour of
// whatever appearance the user is in: near-black in light mode, white in dark.
// Nothing in the disk image can override that. The first version of this file
// used the app's `--bg` family, and in light mode the labels were black on
// near-black and simply could not be read.
//
// A light backdrop only moves the failure to dark mode. So the field sits in the
// middle instead: everything here stays around 15–25% relative luminance, which
// keeps both black and white text at roughly 4:1 or better. That is the whole
// constraint the palette below is solving, and it is why "make it match the app"
// is the one change that must not be made.
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
	appX    = 150.0
	dropX   = 450.0
	arrowY  = 205.0
	shaftLo = 258.0
	shaftHi = 342.0
)

// A purple cosmic field — violet drifting to orchid — chosen for luminance
// before hue: both ends sit near 0.16–0.22 relative luminance, so a black label
// reads at ~4.5:1 and a white one at ~4.5:1 too.
//
// Purple is the awkward hue to hold in that band. It is made of red and blue and
// almost no green, and green carries 71% of relative luminance — so a saturated
// purple is inherently dark, and the ones that land in the band are necessarily
// lighter and chalkier than the deep violet this looks like it should be.
// Anything painted on top has to keep to the band too, which is why the washes
// are low-alpha lilacs rather than the vivid magentas they read as.
var (
	skyA = color.RGBA{0x7b, 0x5f, 0xc0, 0xff}
	skyB = color.RGBA{0x9b, 0x6f, 0xc8, 0xff}
	ink  = color.RGBA{0xff, 0xff, 0xff, 0xff}

	// The tone the two icon slots are normalised to. This single value is what
	// the label contrast actually rests on, and it is picked to sit at the
	// *balance point* rather than as a colour: at 0.18 relative luminance a
	// black label and a white one both come out at ~4.6:1. Moving it either way
	// buys one appearance's legibility with the other's.
	slotTone = color.RGBA{0x83, 0x68, 0xbe, 0xff}
)

// blob is a soft elliptical wash. No blur pass: a radial falloff *is* a blurred
// disc, and computing one costs a square root where the other costs a kernel.
//
// Elliptical and rotatable rather than round, because a sky made of circles
// reads as a sky made of circles. Overlapping ellipses at different angles is
// the cheapest thing that looks like cloud.
type blob struct {
	x, y   float64
	rx, ry float64
	rot    float64 // degrees
	c      color.RGBA
	a      float64
}

// Placed by hand rather than sampled from a generator: a seeded scatter that
// happens to look right is a scatter nobody can adjust.
//
// Depth comes from washes that go *down* as well as up. A field of bright ones
// only lightens everything towards a flat wall; the deep indigos are what make
// it read as cloud with something behind it.
//
// They can be as dramatic as they like, because paintSlot afterwards flattens
// the two zones the labels sit in back into the safe band — without that, every
// value here would be constrained by the worst pixel under a letter, and the
// result was the flat wall this replaced.
var blobs = []blob{
	// The deep field: voids, so the bright work has something to sit against.
	{10, 0, 260, 190, -18, color.RGBA{0x24, 0x0e, 0x4e, 0xff}, 0.55},
	{600, 0, 240, 200, 22, color.RGBA{0x2a, 0x12, 0x56, 0xff}, 0.50},
	{20, 400, 230, 180, 15, color.RGBA{0x28, 0x10, 0x52, 0xff}, 0.45},
	{600, 400, 200, 160, -12, color.RGBA{0x2e, 0x16, 0x5c, 0xff}, 0.40},
	{300, 200, 300, 90, -8, color.RGBA{0x33, 0x1a, 0x62, 0xff}, 0.22},

	// The bright field: wisps drawn long and thin, at angles that disagree.
	{120, 90, 190, 70, -28, color.RGBA{0xd8, 0xc0, 0xf8, 0xff}, 0.34},
	{470, 80, 200, 60, 24, color.RGBA{0xe0, 0xa8, 0xe8, 0xff}, 0.32},
	{300, 355, 260, 90, 6, color.RGBA{0xb8, 0xb0, 0xfa, 0xff}, 0.30},
	{540, 300, 150, 80, -34, color.RGBA{0xf0, 0xc0, 0xe8, 0xff}, 0.26},
	{60, 300, 140, 75, 30, color.RGBA{0xc0, 0xa8, 0xf5, 0xff}, 0.24},
	{300, 40, 170, 55, -6, color.RGBA{0xe8, 0xd8, 0xff, 0xff}, 0.22},

	// Two small dense cores. A nebula needs somewhere the light comes from,
	// or it is fog.
	{132, 74, 46, 30, -28, color.RGBA{0xf6, 0xec, 0xff, 0xff}, 0.34},
	{486, 66, 40, 26, 24, color.RGBA{0xff, 0xe4, 0xfa, 0xff}, 0.30},
}

// A handful of stars, echoing the nebula the app icon is painted on. Fixed
// positions, because the backdrop is a drawing and a drawing is the same every
// time it is regenerated — a diff on this PNG should mean someone changed it.
//
// None of them may land in the two label rows (x 86..214 and 386..514, around
// y 268..305). A star is nearly white, so one behind a letter is a bright pixel
// exactly where the whole palette above is working to keep the contrast even.
var stars = [][3]float64{
	{40, 150, 1.6}, {96, 246, 1.1}, {212, 96, 1.4}, {268, 330, 1.2},
	{330, 130, 1.5}, {392, 60, 1.1}, {430, 352, 1.3}, {498, 190, 1.5},
	{556, 268, 1.2}, {560, 40, 1.4}, {180, 44, 1.2}, {248, 178, 1.0},
	{352, 250, 1.1}, {524, 122, 1.0}, {74, 208, 1.2},
}

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

	// Diagonal rather than vertical: a horizontal band across a window this
	// wide reads as a seam, and the two icon slots sit at the same height, so
	// a vertical ramp gives them identical backing and the pair looks flat.
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			t := (float64(x)/width + float64(y)/height) / 2
			img.SetRGBA(x, y, lerp(skyA, skyB, t))
		}
	}

	for _, b := range blobs {
		paintBlob(img, b)
	}
	// After the nebula and before anything small: the slots have to flatten the
	// clouds, but a star drawn into one and then flattened would be a smudge.
	paintSlot(img, appX)
	paintSlot(img, dropX)
	paintStars(img)
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

func paintBlob(img *image.RGBA, b blob) {
	sin, cos := math.Sincos(b.rot * math.Pi / 180)
	reach := math.Max(b.rx, b.ry)
	for y := int(b.y - reach); y <= int(b.y+reach); y++ {
		for x := int(b.x - reach); x <= int(b.x+reach); x++ {
			if x < 0 || y < 0 || x >= width || y >= height {
				continue
			}
			// Into the ellipse's own frame, then normalised — so one distance
			// covers rotation and both radii.
			dx, dy := float64(x)+0.5-b.x, float64(y)+0.5-b.y
			u := (dx*cos + dy*sin) / b.rx
			v := (-dx*sin + dy*cos) / b.ry
			d := math.Hypot(u, v)
			if d >= 1 {
				continue
			}
			// Smoothstep, so the edge dissolves instead of ending. A linear
			// falloff leaves a faint but perfectly visible ellipse.
			f := 1 - d
			img.SetRGBA(x, y, lerp(img.RGBAAt(x, y), b.c, b.a*f*f*(3-2*f)))
		}
	}
}

// paintSlot flattens the area an icon and its label occupy back towards one
// safe mid tone, and lifts it slightly.
//
// This is what makes the drama above safe. Finder's label colour follows the
// user's appearance and nothing here can override it, so both a black and a
// white label have to stay legible over these two rectangles — which means the
// nebula must not be allowed to put a bright core or a deep void under a letter.
// Constraining every wash by hand to achieve that is what produced a flat wall;
// normalising afterwards, in the two places it actually matters, does not.
//
// The lift is the second job: the app icon is dark artwork, and without it the
// icon reads as a hole rather than as an object resting on something.
func paintSlot(img *image.RGBA, cx float64) {
	const (
		cy = 222.0 // spans the 128px icon and the label line beneath it
		rx = 150.0
		ry = 124.0
		// A plateau, not a peak. A plain radial falloff is already fading by the
		// time it reaches the ends of a long label, which is where "Applications"
		// lost its contrast — the wide word runs out past the part of the ellipse
		// doing the work. Full strength inside 0.62, then a soft edge.
		plateau = 0.62
	)
	for y := int(cy - ry); y <= int(cy+ry); y++ {
		for x := int(cx - rx); x <= int(cx+rx); x++ {
			if x < 0 || y < 0 || x >= width || y >= height {
				continue
			}
			d := math.Hypot((float64(x)+0.5-cx)/rx, (float64(y)+0.5-cy)/ry)
			if d >= 1 {
				continue
			}
			f := clamp((1-d)/(1-plateau), 0, 1)
			s := f * f * (3 - 2*f)
			img.SetRGBA(x, y, lerp(img.RGBAAt(x, y), slotTone, 0.94*s))
		}
	}
}

func paintStars(img *image.RGBA) {
	for _, s := range stars {
		cx, cy, r := s[0], s[1], s[2]
		for y := int(cy - r - 1); y <= int(cy+r+1); y++ {
			for x := int(cx - r - 1); x <= int(cx+r+1); x++ {
				if x < 0 || y < 0 || x >= width || y >= height {
					continue
				}
				d := math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy)
				cov := clamp(r-d+0.5, 0, 1)
				if cov <= 0 {
					continue
				}
				img.SetRGBA(x, y, lerp(img.RGBAAt(x, y), ink, 0.55*cov))
			}
		}
	}
}

// drawArrow paints a chunky arrow pointing from the app icon at the
// Applications alias — the whole instruction the window has to give, and the one
// thing a first-time user needs told.
func drawArrow(img *image.RGBA) {
	// Shaft, then the two strokes of the head. A single polygon fill would
	// need winding rules for a shape this simple; three thick segments is the
	// same picture with none of that, and the round joins come free from the
	// distance function.
	type seg struct{ ax, ay, bx, by, half float64 }
	segs := []seg{
		{shaftLo, arrowY, shaftHi, arrowY, 4.5},
		{shaftHi - 26, arrowY - 22, shaftHi, arrowY, 4.5},
		{shaftHi - 26, arrowY + 22, shaftHi, arrowY, 4.5},
	}

	dist := func(x, y float64) float64 {
		d := math.Inf(1)
		for _, s := range segs {
			d = math.Min(d, distToSegment(x, y, s.ax, s.ay, s.bx, s.by)-s.half)
		}
		return d
	}

	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			px, py := float64(x)+0.5, float64(y)+0.5
			d := dist(px, py)
			if d > 3 {
				continue
			}
			// A soft dark rim under the white, so the arrow holds its shape
			// wherever a pale blob happens to sit behind it.
			if rim := clamp(1-(d-1)/2.5, 0, 1); rim > 0 {
				img.SetRGBA(x, y, lerp(img.RGBAAt(x, y), color.RGBA{0x2a, 0x2f, 0x4d, 0xff}, 0.28*rim))
			}
			// Coverage from the distance rather than an on/off test: at this
			// weight an aliased arrow reads as an artefact of the image, not
			// as a drawn mark.
			if cov := clamp(0.5-d, 0, 1); cov > 0 {
				img.SetRGBA(x, y, lerp(img.RGBAAt(x, y), ink, 0.94*cov))
			}
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
