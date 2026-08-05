package monitor

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"yv/internal/models"
	"yv/internal/runner"
)

// Sink receives every polled sample. Declared here rather than imported so the
// monitor has no dependency on the metrics package; a nil sink is a no-op.
type Sink interface {
	Observe(now time.Time, stats models.ResourceStats)
}

type Monitor struct {
	runner *runner.Runner
	sink   Sink
}

func NewMonitor(r *runner.Runner, sink Sink) *Monitor {
	return &Monitor{runner: r, sink: sink}
}

// Start begins the 3-second resource polling loop. It exits cleanly when ctx is cancelled.
//
// The sink is fed from this loop only, and only when the poll succeeded — a
// failed ps must not be recorded as a genuine zero-RSS sample. It runs
// synchronously: on the common path it is a mutex-guarded map update, and once
// a minute it is a single buffered append, which keeps the shutdown flush
// trivially correct.
func (m *Monitor) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				stats, ok := m.collectStats()
				if ok && m.sink != nil {
					m.sink.Observe(time.Now(), stats)
				}
				wailsRuntime.EventsEmit(ctx, "resource-stats", stats)
			}
		}
	}()
}

// GetResourceStats returns current resource usage on demand.
//
// It deliberately does not feed the sink: this is called from the UI, and
// injecting extra samples into the current minute would skew the N-weighted
// averages the dashboard computes.
func (m *Monitor) GetResourceStats() models.ResourceStats {
	stats, _ := m.collectStats()
	return stats
}

// collectStats returns a snapshot and whether the ps call succeeded.
func (m *Monitor) collectStats() (models.ResourceStats, bool) {
	appPid := os.Getpid()

	entries := m.runner.GetProcessSnapshot()

	pids := make([]string, 0, len(entries)+1)
	pids = append(pids, strconv.Itoa(appPid))
	for _, e := range entries {
		pids = append(pids, strconv.Itoa(e.PID))
	}

	out, err := exec.Command("ps", "-o", "pid=,rss=,pcpu=", "-p", strings.Join(pids, ",")).Output()
	if err != nil {
		return models.ResourceStats{}, false
	}

	parsed := parsePsOutput(string(out))

	stats := models.ResourceStats{}
	if row, ok := parsed[appPid]; ok {
		stats.AppRSS = row.rss
		stats.AppCPU = row.cpu
	}

	for _, e := range entries {
		row := parsed[e.PID]
		cmdStats := models.ProcessStats{
			CmdID:     e.CmdID,
			Label:     e.Label,
			ProjectID: e.ProjectID,
			Group:     e.Group,
			RSS:       row.rss,
			CPU:       row.cpu,
		}
		stats.Commands = append(stats.Commands, cmdStats)
		stats.TotalCmdRSS += row.rss
		stats.TotalCmdCPU += row.cpu
	}

	return stats, true
}

type psRow struct {
	rss int64
	cpu float64
}

// parsePsOutput parses the output of `ps -o pid=,rss=,pcpu=` into a pid→stats map.
// Extracted as a pure function so it can be unit-tested without shelling out.
func parsePsOutput(out string) map[int]psRow {
	result := make(map[int]psRow)
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		rssKB, _ := strconv.ParseInt(fields[1], 10, 64)
		cpu, _ := strconv.ParseFloat(fields[2], 64)
		result[pid] = psRow{rss: rssKB * 1024, cpu: cpu}
	}
	return result
}
