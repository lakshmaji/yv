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

type Monitor struct {
	runner *runner.Runner
}

func NewMonitor(r *runner.Runner) *Monitor {
	return &Monitor{runner: r}
}

// Start begins the 3-second resource polling loop. It exits cleanly when ctx is cancelled.
func (m *Monitor) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				stats := m.collectStats()
				wailsRuntime.EventsEmit(ctx, "resource-stats", stats)
			}
		}
	}()
}

// GetResourceStats returns current resource usage on demand.
func (m *Monitor) GetResourceStats() models.ResourceStats {
	return m.collectStats()
}

type pidEntry struct {
	pid   int
	cmdID string
	label string
}

func (m *Monitor) collectStats() models.ResourceStats {
	appPid := os.Getpid()

	snapshot := m.runner.GetProcessSnapshot()
	entries := make([]pidEntry, len(snapshot))
	for i, e := range snapshot {
		entries[i] = pidEntry{pid: e.PID, cmdID: e.CmdID, label: e.Label}
	}

	pids := make([]string, 0, len(entries)+1)
	pids = append(pids, strconv.Itoa(appPid))
	for _, e := range entries {
		pids = append(pids, strconv.Itoa(e.pid))
	}

	out, err := exec.Command("ps", "-o", "pid=,rss=,pcpu=", "-p", strings.Join(pids, ",")).Output()
	if err != nil {
		return models.ResourceStats{}
	}

	parsed := parsePsOutput(string(out))

	stats := models.ResourceStats{}
	if row, ok := parsed[appPid]; ok {
		stats.AppRSS = row.rss
		stats.AppCPU = row.cpu
	}

	for _, e := range entries {
		row := parsed[e.pid]
		cmdStats := models.ProcessStats{
			CmdID: e.cmdID,
			Label: e.label,
			RSS:   row.rss,
			CPU:   row.cpu,
		}
		stats.Commands = append(stats.Commands, cmdStats)
		stats.TotalCmdRSS += row.rss
		stats.TotalCmdCPU += row.cpu
	}

	return stats
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
