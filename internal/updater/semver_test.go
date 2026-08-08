package updater

import "testing"

func TestCanonicalVersion(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"tag form", "v1.2.3", "1.2.3"},
		{"plain form", "1.2.3", "1.2.3"},
		{"surrounding space", "  v1.2.3\n", "1.2.3"},
		{"only the first v", "vv1.2.3", "v1.2.3"},
		{"empty", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := CanonicalVersion(tt.in); got != tt.want {
				t.Errorf("CanonicalVersion(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestNewer(t *testing.T) {
	tests := []struct {
		name string
		a, b string
		want bool
	}{
		{"patch bump", "1.0.1", "1.0.0", true},
		{"patch bump reversed", "1.0.0", "1.0.1", false},
		{"minor bump", "1.1.0", "1.0.9", true},
		{"major bump", "2.0.0", "1.99.99", true},
		{"identical", "1.2.3", "1.2.3", false},
		{"identical with v on one side", "v1.2.3", "1.2.3", false},
		{"tag form compares", "v0.2.0", "v0.1.9", true},

		// Numeric components are numbers, not strings. Lexically "10" < "9",
		// so a string compare would strand the project at 0.9.x forever.
		{"double digit minor", "0.10.0", "0.9.0", true},
		{"double digit patch", "1.0.10", "1.0.9", true},

		// A prerelease is older than its own release.
		{"release beats its prerelease", "1.0.0", "1.0.0-alpha.1", true},
		{"prerelease loses to release", "1.0.0-alpha.1", "1.0.0", false},
		{"prerelease still beats older release", "1.0.0-alpha.1", "0.9.9", true},

		// Prerelease ordering, the part a string compare gets wrong.
		{"alpha.10 beats alpha.2", "1.0.0-alpha.10", "1.0.0-alpha.2", true},
		{"alpha.2 loses to alpha.10", "1.0.0-alpha.2", "1.0.0-alpha.10", false},
		{"beta beats alpha", "1.0.0-beta.1", "1.0.0-alpha.9", true},
		{"rc beats beta", "1.0.0-rc.1", "1.0.0-beta.11", true},
		{"more identifiers wins", "1.0.0-alpha.1", "1.0.0-alpha", true},
		{"fewer identifiers loses", "1.0.0-alpha", "1.0.0-alpha.1", false},
		{"numeric loses to alphanumeric", "1.0.0-alpha", "1.0.0-1", true},
		{"leading zero is alphanumeric", "1.0.0-01", "1.0.0-1", true},

		// Build metadata is excluded from precedence entirely.
		{"build metadata ignored", "1.0.0+build.9", "1.0.0+build.1", false},
		{"build metadata does not mask a bump", "1.0.1+a", "1.0.0+z", true},

		// Anything we cannot parse must lose. Winning means downloading it.
		{"dev is never newer", "dev", "1.0.0", false},
		{"nothing is newer than dev", "1.0.0", "dev", false},
		{"empty candidate", "", "1.0.0", false},
		{"two components", "1.2", "1.0.0", false},
		{"four components", "1.2.3.4", "1.0.0", false},
		{"non-numeric component", "1.x.0", "1.0.0", false},
		{"negative component", "1.-2.0", "1.0.0", false},
		{"signed component", "1.+2.0", "1.0.0", false},
		{"trailing hyphen", "1.0.0-", "0.9.0", false},
		{"empty prerelease identifier", "1.0.0-alpha..1", "0.9.0", false},
		{"words", "latest", "1.0.0", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Newer(tt.a, tt.b); got != tt.want {
				t.Errorf("Newer(%q, %q) = %v, want %v", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

// Newer is a strict ordering, so for any two versions at most one direction can
// hold. A comparator that says both are newer than the other would make the
// "is there an update" question answer yes forever.
func TestNewerIsAsymmetric(t *testing.T) {
	versions := []string{
		"0.1.0", "0.9.0", "0.10.0", "1.0.0-alpha", "1.0.0-alpha.1",
		"1.0.0-alpha.2", "1.0.0-alpha.10", "1.0.0-beta", "1.0.0-rc.1",
		"1.0.0", "1.0.1", "1.1.0", "2.0.0",
	}
	for _, a := range versions {
		for _, b := range versions {
			if Newer(a, b) && Newer(b, a) {
				t.Errorf("both Newer(%q, %q) and Newer(%q, %q)", a, b, b, a)
			}
			if a == b && Newer(a, b) {
				t.Errorf("Newer(%q, %q) with equal versions", a, b)
			}
		}
	}
}

// The list above is written in ascending order, so every element must be newer
// than every element before it. This catches an ordering bug that a pairwise
// table can miss by simply not containing the pair.
func TestVersionsFormATotalOrder(t *testing.T) {
	ascending := []string{
		"0.1.0", "0.2.0", "0.9.0", "0.10.0", "0.10.1",
		"1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.2", "1.0.0-alpha.10",
		"1.0.0-beta", "1.0.0-beta.2", "1.0.0-rc.1", "1.0.0",
		"1.0.1", "1.1.0", "2.0.0",
	}
	for i := range ascending {
		for j := range ascending {
			want := i > j
			if got := Newer(ascending[i], ascending[j]); got != want {
				t.Errorf("Newer(%q, %q) = %v, want %v",
					ascending[i], ascending[j], got, want)
			}
		}
	}
}
