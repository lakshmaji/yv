# Reply to the classic confinement refusal

The refusal is on **notability**, not technique. That is not an argument anyone wins, so the
decision is to accept it, park the request, and return when the project has adoption behind it.

Keep the reply short. Do not re-argue any of the four technical points — the reviewer already
mapped three of them onto unsupported categories, and relitigating that now spends goodwill we
will want when we re-apply to the same people.

---

```
Thanks for the detailed review, and for being clear about the reasoning — that's
a fair call and I accept it. The project is young and I'm not going to argue the
maturity point.

I'll park the classic request for now, keep distributing the .deb, tarball and
AppImage from GitHub releases, and come back once there's real adoption behind
the project.

One question, so I don't spend reviewer time twice: is there a rough bar for
"mature and well-known" that I can aim at — downloads, time published, active
contributors, something else? Entirely fair if the answer is "you'll know it when
you see it", but if there's a concrete signal you look for, I'd rather target
that than guess.

Thanks again for the quick turnaround.
```

---

## Why it is this short

- Notability is not a technical objection. Pushing on it reads as not listening, and the
  re-application lands in front of the same reviewers.
- The one question is the only thing with future value: it converts "come back when you're
  mature" into something we can actually measure against.

## What is deliberately absent

- **No rebuttal of the "ship in instead snap" mapping.** It is arguably wrong — that category
  covers an app's *own* dependencies, whereas yv's problem is the user's toolchain, which
  cannot be staged by definition. Worth raising when we re-apply, with evidence. Not worth
  raising now, attached to a decision we are accepting.
- **No mention of `personal-files`.** Engaging with it concedes that dot-file access is the
  problem, when execution is.
- **No comparison to VS Code or other granted classic snaps.** "They got it" is the weakest
  argument available and reviewers hear it constantly.
- **No timeline pressure**, and no mention that the snap is already built.
