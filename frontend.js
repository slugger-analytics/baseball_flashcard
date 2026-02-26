class ConfidenceSliderManager {
  constructor() {
    this.slider = document.getElementById('confidence-slider');
    this.label = document.getElementById('confidence-label');
    this.currentBatter = null;
    this.currentTeam = null;
    this.currentTeamsData = null;
    
    this.init();
  }
  
  init() {
    if (!this.slider) return;
    
    // Update label with percentage
    this.updateLabel(this.slider.value);
    
    // Add tooltip
    this.addTooltip();
    
    // Add event listener with debounce
    this.slider.addEventListener('input', this.debounce((e) => {
      this.handleSliderChange(e.target.value);
    }, 300));
  }
  
  updateLabel(value) {
    if (this.label) {
      this.label.innerText = `Weakness Precision: ${value}%`;
    }
  }
  
  addTooltip() {
    const container = this.slider.parentElement;
    const tooltip = document.createElement('span');
    tooltip.className = 'tooltip-icon';
    tooltip.innerHTML = 'ⓘ';
    tooltip.title = 'Controls how much statistical evidence is required to highlight a zone. Higher percentages filter out noise and only show the batter\'s most proven weaknesses.';
    container.appendChild(tooltip);
  }
  
  async handleSliderChange(value) {
    this.updateLabel(value);
    
    // get current context ----??
    this.currentBatter = window.selectedBatter || null;
    this.currentTeam = window.selectedTeam || null;
    this.currentTeamsData = window.teamsData || null;
    
    if (!this.currentBatter || !this.currentTeam || !this.currentTeamsData) {
      console.log('No batter selected yet');
      return;
    }
    
    try {
      const response = await fetch('/api/weakness-zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confidenceThreshold: parseInt(value),
          teamsData: this.currentTeamsData,
          selectedTeam: this.currentTeam,
          selectedBatter: this.currentBatter
        })
      });
      
      const data = await response.json();
      
      if (response.ok) {
        this.updateZonesDisplay(data.zones, data.metadata);
      }
    } catch (error) {
      console.error('Error updating weakness zones:', error);
    }
  }
  
  updateZonesDisplay(zones, metadata) {
    const container = document.getElementById('zones-container');
    if (!container) return;
    
    // clear existing zones
    container.innerHTML = '';
    
    // add zone cards
    zones.forEach(zone => {
      const zoneCard = document.createElement('div');
      zoneCard.className = 'zone-card';
      
      // determine color based on weakness score
      let bgColor = '#ffebee'; // light red
      if (zone.weaknessScore < 30) bgColor = '#fff3e0'; // light orange
      if (zone.weaknessScore < 20) bgColor = '#e8f5e8'; // light green
      
      zoneCard.style.backgroundColor = bgColor;
      
      zoneCard.innerHTML = `
        <div class="zone-number">Zone ${zone.zone}</div>
        <div class="zone-value">${zone.weaknessScore.toFixed(1)}%</div>
        <div class="zone-label">Weakness Score</div>
        <div class="zone-stats">
          <small>${zone.sampleSize} pitches</small>
          <small>Confidence: ${zone.confidence}</small>
        </div>
      `;
      
      container.appendChild(zoneCard);
    });
    
    // add metadata display
    const metaDiv = document.createElement('div');
    metaDiv.className = 'zones-metadata';
    metaDiv.innerHTML = `
      <small>Showing ${metadata.zonesDisplayed} of ${metadata.totalZonesAnalyzed} zones</small>
    `;
    container.appendChild(metaDiv);
  }
  
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
}

// initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.confidenceManager = new ConfidenceSliderManager();
});

// PDF report generation
async function generatePDFReport() {
  try {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    const minVelocity = document.getElementById('velocity-min').value;
    const confidenceValue = document.getElementById('confidence-slider').value;
    const selectedBatter = window.selectedBatter || '';
    const selectedTeam = window.selectedTeam || '';
    
    const params = new URLSearchParams({
      startDate,
      endDate,
      minVelocity,
      confidenceThreshold: confidenceValue,
      selectedTeam,
      selectedBatter
    });
    
    const response = await fetch(`/api/generate-report?${params.toString()}`);
    const data = await response.json();
    
    if (response.ok) {
      // Create print-friendly window
      const printWindow = window.open('', '_blank');
      printWindow.document.write(createPrintHTML(data.reportData));
      printWindow.document.close();
      printWindow.print();
    }
  } catch (error) {
    console.error('Error generating report:', error);
    alert('Error generating report. Please try again.');
  }
}

function createPrintHTML(reportData) { 
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Pitch Analysis Report</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 0.5in;
          line-height: 1.4;
          color: #333;
        }
        h1 {
          color: #2c3e50;
          border-bottom: 2px solid #3498db;
          padding-bottom: 10px;
        }
        .metadata {
          background: #f8f9fa;
          padding: 15px;
          border-left: 4px solid #3498db;
          margin: 20px 0;
          font-size: 12pt;
        }
        .summary {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 15px;
          margin: 20px 0;
        }
        .summary-item {
          background: #f0f0f0;
          padding: 10px;
          text-align: center;
          border-radius: 4px;
        }
        .team-section {
          margin: 20px 0;
          page-break-inside: avoid;
        }
        .team-name {
          font-size: 16pt;
          font-weight: bold;
          color: #3498db;
          margin: 15px 0 10px 0;
          border-bottom: 1px solid #ccc;
          padding-bottom: 5px;
        }
        .batter-card {
          border: 1px solid #ddd;
          padding: 12px;
          margin: 10px 0;
          border-radius: 4px;
          page-break-inside: avoid;
        }
        .batter-name {
          font-size: 14pt;
          font-weight: bold;
          color: #2c3e50;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
          margin-top: 10px;
          font-size: 11pt;
        }
        .stat {
          text-align: center;
        }
        .stat-label {
          color: #7f8c8d;
          font-size: 9pt;
          text-transform: uppercase;
        }
        .stat-value {
          font-size: 14pt;
          font-weight: bold;
          color: #2c3e50;
        }
        .footer {
          margin-top: 30px;
          text-align: center;
          font-size: 9pt;
          color: #7f8c8d;
          border-top: 1px solid #eee;
          padding-top: 10px;
        }
        @media print {
          body { margin: 0.25in; }
          .batter-card { break-inside: avoid; }
        }
      </style>
    </head>
    <body>
      <h1>Pitch Analysis Report</h1>
      
      <div class="metadata">
        <strong>Generated:</strong> ${new Date(reportData.metadata.generatedAt).toLocaleString()}<br>
        <strong>Date Range:</strong> ${reportData.metadata.dateRange.start} to ${reportData.metadata.dateRange.end}<br>
        <strong>Velocity Filter:</strong> ${reportData.metadata.velocityRange}<br>
        <strong>Weakness Precision:</strong> ${reportData.metadata.confidenceThreshold}%<br>
        ${reportData.metadata.selectedBatter ? `<strong>Selected Batter:</strong> ${reportData.metadata.selectedBatter}<br>` : ''}
      </div>
      
      <div class="summary">
        <div class="summary-item">
          <div class="stat-label">Teams</div>
          <div class="stat-value">${reportData.summary.totalTeams}</div>
        </div>
        <div class="summary-item">
          <div class="stat-label">Batters</div>
          <div class="stat-value">${reportData.summary.totalBatters}</div>
        </div>
        <div class="summary-item">
          <div class="stat-label">Pitches</div>
          <div class="stat-value">${reportData.summary.totalPitchesProcessed}</div>
        </div>
      </div>
      
      ${Object.entries(reportData.teamsData).map(([teamName, batters]) => `
        <div class="team-section">
          <div class="team-name">${teamName}</div>
          ${batters.map(batter => `
            <div class="batter-card">
              <div class="batter-name">${batter.batter} (${batter.handedness})</div>
              <div class="stats-grid">
                <div class="stat">
                  <div class="stat-label">Pitches</div>
                  <div class="stat-value">${batter.stats.totalPitches}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Contact %</div>
                  <div class="stat-value">${batter.stats.swings ? ((batter.stats.contact / batter.stats.swings) * 100).toFixed(1) : 0}%</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Whiff %</div>
                  <div class="stat-value">${batter.stats.swings ? ((batter.stats.whiffs / batter.stats.swings) * 100).toFixed(1) : 0}%</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Hard Hit %</div>
                  <div class="stat-value">${batter.stats.contact ? ((batter.stats.hardContact / batter.stats.contact) * 100).toFixed(1) : 0}%</div>
                </div>
              </div>
              ${batter === reportData.batterDetail ? `
                <div style="margin-top: 15px; border-top: 1px dashed #ccc; padding-top: 10px;">
                  <strong>Weakness Zones (${reportData.metadata.confidenceThreshold}% precision):</strong>
                  <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px;">
                    ${Object.entries(batter.weaknessZones || {}).map(([zone, data]) => `
                      <div style="background: #f5f5f5; padding: 8px; text-align: center; border-radius: 4px;">
                        <strong>Zone ${zone}</strong><br>
                        ${data.weaknessScore.toFixed(1)}% weakness<br>
                        <small>${data.sampleSize} pitches</small>
                      </div>
                    `).join('')}
                  </div>
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      `).join('')}
      
      <div class="footer">
        Confidential Scouting Report - Generated by Pitch Analysis System
      </div>
    </body>
    </html>
  `;
}

// Add print button handler
document.getElementById('print-report-btn')?.addEventListener('click', generatePDFReport);


