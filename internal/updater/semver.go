// Package updater finds, verifies and installs new releases of yv.
//
// Nothing here reaches the network unless the running build knows its own
// version: main.version is "dev" for anything that skipped the Makefile, and the
// caller is expected to check that before asking for anything.
package updater

import (
	"strconv"
	"strings"
)

// Semantic version comparison, hand-rolled rather than pulled in.
//
// The alternative is golang.org/x/mod/semver, which is a real dependency on a
// module that also carries the whole module-path and pseudo-version machinery,
// for a package whose entire external surface here is "is this tag newer than
// mine". The rules are in the spec, they do not change, and they are covered by
// a table in semver_test.go — so the cost of owning them is a hundred lines
// that will never need touching.

// version is a parsed tag. An unparseable string yields ok=false, which the
// comparison treats as "older than everything" — a release named something we
// do not understand must never win, since winning means downloading it.
type version struct {
	nums [3]int
	pre  []string
	ok   bool
}

// CanonicalVersion strips the leading "v" that git tags carry and release assets
// embed, so "v0.2.1" and "0.2.1" are the same version.
//
// The two forms genuinely coexist and both are correct in their own place: the
// tag is v-prefixed by convention, and wails.json's productVersion is not,
// because a .deb version cannot start with a letter. Rather than pick a winner,
// every value is put through here at the boundary.
func CanonicalVersion(s string) string {
	return strings.TrimPrefix(strings.TrimSpace(s), "v")
}

// Newer reports whether a is a strictly newer version than b.
func Newer(a, b string) bool {
	pa, pb := parseVersion(a), parseVersion(b)
	// An unparseable candidate loses, and an unparseable current version means
	// we cannot tell — "dev" reaches here in tests, and offering a dev build an
	// update it would then compare against nothing is worse than doing nothing.
	if !pa.ok || !pb.ok {
		return false
	}
	return compare(pa, pb) > 0
}

func parseVersion(s string) version {
	s = CanonicalVersion(s)

	// Build metadata is explicitly excluded from precedence by the spec, so it
	// is dropped before anything else looks at the string.
	if i := strings.IndexByte(s, '+'); i >= 0 {
		s = s[:i]
	}

	var pre []string
	if i := strings.IndexByte(s, '-'); i >= 0 {
		// A trailing "-" with nothing after it is not a prerelease, it is a
		// malformed tag; treating it as one would make "1.0.0-" sort below
		// "1.0.0" for no reason a reader could see.
		if i == len(s)-1 {
			return version{}
		}
		pre = strings.Split(s[i+1:], ".")
		s = s[:i]
	}

	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return version{}
	}

	var out version
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		// Rejecting the sign explicitly: Atoi happily accepts "-1" and "+1",
		// and the leading "-" case cannot get here (it was split off above)
		// while "1.+2.3" otherwise parses as 1.2.3.
		if err != nil || n < 0 || strings.ContainsAny(p, "+-") {
			return version{}
		}
		out.nums[i] = n
	}

	for _, id := range pre {
		if id == "" {
			return version{}
		}
	}

	out.pre = pre
	out.ok = true
	return out
}

// compare returns -1, 0 or 1 following semver 2.0.0 precedence.
func compare(a, b version) int {
	for i := 0; i < 3; i++ {
		if a.nums[i] != b.nums[i] {
			return sign(a.nums[i] - b.nums[i])
		}
	}

	// "A pre-release version has lower precedence than a normal version."
	// This is the rule that makes 1.0.0-alpha < 1.0.0, and getting it backwards
	// would ship every release candidate as an upgrade over the final.
	switch {
	case len(a.pre) == 0 && len(b.pre) == 0:
		return 0
	case len(a.pre) == 0:
		return 1
	case len(b.pre) == 0:
		return -1
	}

	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		if c := comparePreID(a.pre[i], b.pre[i]); c != 0 {
			return c
		}
	}

	// All shared identifiers equal: more identifiers wins, so
	// alpha < alpha.1. Length is the tiebreak, not the value.
	return sign(len(a.pre) - len(b.pre))
}

// comparePreID orders two prerelease identifiers.
//
// Numeric identifiers compare numerically, which is the whole reason this is not
// a string comparison: lexically, "alpha.10" sorts below "alpha.2", so a tenth
// alpha would look older than the second and never be offered.
func comparePreID(a, b string) int {
	na, aNum := preNumber(a)
	nb, bNum := preNumber(b)

	switch {
	case aNum && bNum:
		return sign(na - nb)
	case aNum:
		// "Numeric identifiers always have lower precedence than alphanumeric."
		return -1
	case bNum:
		return 1
	default:
		return strings.Compare(a, b)
	}
}

func preNumber(s string) (int, bool) {
	n, err := strconv.Atoi(s)
	// Leading zeros make an identifier alphanumeric per the spec ("01" is not a
	// numeric identifier), and Atoi would otherwise silently read it as 1.
	if err != nil || n < 0 || (len(s) > 1 && s[0] == '0') {
		return 0, false
	}
	return n, true
}

func sign(n int) int {
	switch {
	case n > 0:
		return 1
	case n < 0:
		return -1
	default:
		return 0
	}
}
