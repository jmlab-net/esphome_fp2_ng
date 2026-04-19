/**
 * Aqara FP2 Presence Sensor Card for Home Assistant
 *
 * Configuration options:
 * - entity_prefix: (required) The entity prefix for the FP2 sensor (e.g., "sensor.fp2_living_room")
 * - title: (optional) Card title
 * - display_mode: (optional) "full" or "zoomed" - Default: "full"
 * - show_grid: (optional) Show grid lines - Default: true
 * - show_sensor_position: (optional) Show sensor position marker - Default: true
 * - show_zone_labels: (optional) Show zone labels - Default: true
 * - auto_tracking: (optional) Automatically enable target tracking when card loads - Default: false
 */
class AqaraFP2Card extends HTMLElement {
  constructor() {
    super();
    this.config = {};
    this.displayMode = "full";
    this.showGrid = true;
    this.showSensorPosition = true;
    this.showZoneLabels = true;
    this.gridSize = 14;
    this._lastRender = 0;
    this._pendingUpdate = null;

    // --- Edit mode state ---
    // editMode: null (read-only) | 'edge' | 'interference' | 'entry_exit' | {type:'zone', id:N}
    this.editMode = null;
    this.pendingGrid = null;     // 14x14 0/1 array; current working copy while editing
    this._originalGrid = null;   // snapshot taken at edit start, for dirty check + cancel
    this.painting = false;       // true while pointer is down and dragging
    this.paintMode = 'paint';    // 'paint' | 'erase' — locked on pointerdown from initial cell value
    this._paintedCells = null;   // Set of "x,y" strings visited in current drag
    this._applyInFlight = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.content) {
      this.initializeCard();
    }
    // Detect device-config changes that live *outside* the map_config JSON
    // so the card refetches instead of waiting for a page reload.
    this._detectConfigChanges(hass);
    // Throttle updates — radar streams at 2-3Hz but hass fires on ANY state change
    const now = Date.now();
    if (now - this._lastRender < 250) {
      if (!this._pendingUpdate) {
        this._pendingUpdate = setTimeout(() => {
          this._pendingUpdate = null;
          this._doUpdate();
        }, 250 - (now - this._lastRender));
      }
      return;
    }
    this._doUpdate();
  }

  // Watch HA entity states that, if changed, invalidate the cached mapConfig
  // (fetched one-shot at init). Currently: mounting_position. Could extend to
  // left_right_reverse once that's exposed as an entity.
  _detectConfigChanges(hass) {
    if (!this.config || !this.config.entity_prefix) return;
    const deviceName = this.config.entity_prefix.replace(/^[^.]+\./, '');
    const mount = hass.states[`select.${deviceName}_mounting_position`];
    const mountState = mount ? mount.state : null;
    if (mountState && this._lastKnownMount !== undefined && mountState !== this._lastKnownMount) {
      // Small delay so the backend has time to finish persisting + kicking
      // the re-init before we ask for the fresh map_config. This also
      // debounces against rapid hass state bursts during re-init.
      if (this._mountRefetchTimer) clearTimeout(this._mountRefetchTimer);
      this._mountRefetchTimer = setTimeout(() => {
        this._mountRefetchTimer = null;
        this.fetchMapConfig();
      }, 500);
    }
    this._lastKnownMount = mountState;
  }

  _doUpdate() {
    this._lastRender = Date.now();
    if (!this._hass || !this.canvas) return;
    const data = this.gatherEntityData();
    this.updateLiveViewButton();
    this.renderCanvas(data);
    this.updateInfoPanel(data);
  }

  setConfig(config) {
    if (!config.entity_prefix) {
      throw new Error("You need to define entity_prefix");
    }
    this.config = config;
    this.displayMode = config.display_mode || "full";
    this.showGrid = config.show_grid !== false;
    this.showSensorPosition = config.show_sensor_position !== false;
    this.showZoneLabels = config.show_zone_labels !== false;
    this.autoTracking = config.auto_tracking === true;
  }

  getReportTargetsSwitchEntity() {
    const prefix = this.config.entity_prefix;
    const deviceName = prefix.replace(/^[^.]+\./, '');
    return `switch.${deviceName}_report_targets`;
  }

  toggleLiveView() {
    const switchEntity = this.getReportTargetsSwitchEntity();
    const switchState = this._hass.states[switchEntity];
    if (!switchState) return;
    const service = switchState.state === 'on' ? 'turn_off' : 'turn_on';
    this._hass.callService('switch', service, { entity_id: switchEntity });
  }

  async fetchMapConfig() {
    const deviceName = this.config.entity_prefix.replace(/^[^.]+\./, '');
    const service = `${deviceName}_get_map_config`;
    try {
      const response = await this._hass.callService('esphome', service, {}, undefined, undefined, true);
      this.mapConfig = response.response;
      this._doUpdate();
    } catch (e) {
      console.error(`[FP2 Card] Failed to fetch map config:`, e);
    }
  }

  // Resolve CSS variable to actual color for canvas (canvas can't use var())
  _resolveColor(varName, fallback) {
    if (!this._computedStyle) {
      this._computedStyle = getComputedStyle(this);
    }
    return this._computedStyle.getPropertyValue(varName).trim() || fallback;
  }

  initializeCard() {
    this.innerHTML = `
      <ha-card>
        <div class="fp2-header">
          <div class="fp2-title">${this.config.title || "Aqara FP2"}</div>
          <div class="fp2-controls">
            <button class="fp2-btn edit-toggle" title="Edit grids">
              <ha-icon icon="mdi:pencil"></ha-icon>
            </button>
            <button class="fp2-btn live-view-toggle" title="Toggle Live Tracking">
              <ha-icon icon="mdi:crosshairs-gps"></ha-icon>
            </button>
          </div>
        </div>
        <div class="fp2-edit-toolbar" hidden>
          <select class="fp2-layer-select" title="Layer to edit">
            <option value="edge">Edge / Boundary</option>
            <option value="interference">Interference</option>
            <option value="entry_exit">Entry / Exit</option>
          </select>
          <button class="fp2-btn fp2-apply-btn" title="Write grid to device">
            <ha-icon icon="mdi:content-save"></ha-icon> Apply
          </button>
          <button class="fp2-btn fp2-cancel-btn" title="Discard pending edits">
            <ha-icon icon="mdi:close"></ha-icon> Cancel
          </button>
          <span class="fp2-dirty-dot" title="Unsaved edits"></span>
          <span class="fp2-edit-hint">click &amp; drag to paint / erase</span>
          <span class="fp2-vsep"></span>
          <label class="fp2-mount-label" title="Mount position (triggers radar re-init)">
            Mount:
            <select class="fp2-mount-select">
              <option value="Wall">Wall</option>
              <option value="Left Corner">Left Corner</option>
              <option value="Right Corner">Right Corner</option>
            </select>
          </label>
        </div>
        <div class="fp2-content">
          <canvas id="fp2-canvas"></canvas>
        </div>
        <div class="fp2-info"></div>
      </ha-card>
      <style>
        ha-card {
          padding: 16px;
          overflow: hidden;
        }
        .fp2-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }
        .fp2-title {
          font-size: 18px;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        .fp2-controls {
          display: flex;
          gap: 8px;
        }
        .fp2-btn {
          background: var(--secondary-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          padding: 6px 8px;
          cursor: pointer;
          color: var(--primary-text-color);
          transition: all 0.2s ease;
        }
        .fp2-btn:hover {
          background: var(--primary-color);
          color: var(--text-primary-color);
        }
        .fp2-btn.active {
          background: var(--primary-color);
          color: var(--text-primary-color);
          box-shadow: 0 0 8px rgba(var(--rgb-primary-color), 0.4);
        }
        .fp2-content {
          display: flex;
          flex-direction: column;
        }
        .fp2-content {
          position: relative;
        }
        #fp2-canvas {
          width: 100%;
          height: auto;
          max-width: 100%;
          display: block;
          border-radius: 8px;
          box-sizing: border-box;
        }
        .fp2-info {
          position: absolute;
          bottom: 8px;
          left: 8px;
          right: 8px;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          padding: 6px 10px;
          background: rgba(0,0,0,0.6);
          backdrop-filter: blur(4px);
          border-radius: 6px;
          font-size: 13px;
          color: var(--secondary-text-color);
        }
        .fp2-info .fp2-stat {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .fp2-info .fp2-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
        }
        .fp2-info .fp2-dot.presence { background: #4CAF50; }
        .fp2-info .fp2-dot.no-presence { background: #666; }
        .fp2-info .fp2-dot.target { background: #FF9800; }
        .fp2-info .fp2-dot.zone-on { background: #42A5F5; }
        .fp2-info .fp2-dot.zone-off { background: rgba(66,165,245,0.3); }

        /* --- Edit mode toolbar --- */
        .fp2-edit-toolbar {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          padding: 8px 6px;
          margin-bottom: 8px;
          background: var(--secondary-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 8px;
        }
        .fp2-edit-toolbar[hidden] { display: none; }
        .fp2-edit-toolbar .fp2-layer-select {
          background: var(--card-background-color);
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          padding: 4px 8px;
          font-size: 13px;
        }
        .fp2-edit-toolbar .fp2-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 13px;
        }
        .fp2-edit-toolbar .fp2-btn[disabled] {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .fp2-dirty-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #FF9800;
          visibility: hidden;
        }
        .fp2-dirty-dot.active { visibility: visible; }
        .fp2-edit-hint {
          font-size: 12px;
          color: var(--secondary-text-color);
          margin-left: auto;
        }
        .fp2-vsep {
          width: 1px;
          height: 20px;
          background: var(--divider-color);
          margin: 0 2px;
        }
        .fp2-mount-label {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 13px;
          color: var(--secondary-text-color);
        }
        .fp2-mount-label select {
          background: var(--card-background-color);
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          padding: 4px 8px;
          font-size: 13px;
        }
        /* Canvas flash feedback on apply */
        #fp2-canvas {
          transition: box-shadow 0.2s ease;
        }
        #fp2-canvas.flash-ok   { box-shadow: 0 0 0 3px rgba(76,175,80,0.85); }
        #fp2-canvas.flash-err  { box-shadow: 0 0 0 3px rgba(244,67,54,0.85); }
        /* Crosshair cursor while editing */
        .fp2-editing #fp2-canvas { cursor: crosshair; touch-action: none; }
      </style>
    `;

    this.content = this.querySelector(".fp2-content");
    this.canvas = this.querySelector("#fp2-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.infoPanel = this.querySelector(".fp2-info");

    this.querySelector(".live-view-toggle").addEventListener("click", () => this.toggleLiveView());

    // Edit-mode controls
    this.querySelector(".edit-toggle").addEventListener("click", () => this.toggleEditMode());
    this.querySelector(".fp2-apply-btn").addEventListener("click", () => this.applyPendingGrid());
    this.querySelector(".fp2-cancel-btn").addEventListener("click", () => this.cancelEdit());
    this.querySelector(".fp2-layer-select").addEventListener("change", (e) => this.setEditLayer(e.target.value));
    this.querySelector(".fp2-mount-select").addEventListener("change", (e) => this.handleMountChange(e));

    // Pointer-driven paint/erase. Pointer events cover mouse + touch + pen with
    // a single API; pointerdown also fires a click afterwards, so nothing here
    // breaks the previous read-only click path (which did nothing anyway).
    this.canvas.addEventListener("pointerdown", (e) => this.handlePointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.handlePointerMove(e));
    this.canvas.addEventListener("pointerup",   () => this.handlePointerUp());
    this.canvas.addEventListener("pointercancel",() => this.handlePointerUp());
    this.canvas.addEventListener("pointerleave",() => this.handlePointerUp());

    this.resizeObserver = new ResizeObserver(() => this._doUpdate());
    this.resizeObserver.observe(this.content);

    this.fetchMapConfig();

    // Auto-enable tracking when card loads
    if (this.autoTracking) {
      this._enableTracking();
    }
  }

  _enableTracking() {
    const switchEntity = this.getReportTargetsSwitchEntity();
    const switchState = this._hass && this._hass.states[switchEntity];
    if (switchState && switchState.state === 'off') {
      this._hass.callService('switch', 'turn_on', { entity_id: switchEntity });
      this._autoTrackingEnabled = true;
    }
  }

  _disableTracking() {
    if (!this._autoTrackingEnabled) return;
    const switchEntity = this.getReportTargetsSwitchEntity();
    const switchState = this._hass && this._hass.states[switchEntity];
    if (switchState && switchState.state === 'on') {
      this._hass.callService('switch', 'turn_off', { entity_id: switchEntity });
    }
    this._autoTrackingEnabled = false;
  }

  updateLiveViewButton() {
    const switchEntity = this.getReportTargetsSwitchEntity();
    const switchState = this._hass.states[switchEntity];
    const button = this.querySelector(".live-view-toggle");
    if (!button) return;
    button.classList.toggle('active', switchState && switchState.state === 'on');
  }

  gatherEntityData() {
    const prefix = this.config.entity_prefix;
    const hass = this._hass;
    const deviceName = prefix.replace(/^[^.]+\./, '');

    const getState = (entityId) => {
      const s = hass.states[entityId];
      return s ? s.state : null;
    };

    const decodeTargets = (base64String) => {
      if (!base64String || base64String === "" || base64String === "unknown") return [];
      try {
        const bin = atob(base64String);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (bytes.length < 1) return [];
        const count = bytes[0];
        const targets = [];
        const i16 = (o) => { const v = (bytes[o] << 8) | bytes[o+1]; return v > 32767 ? v - 65536 : v; };
        for (let i = 0; i < count; i++) {
          const o = 1 + (i * 14);
          if (o + 14 > bytes.length) break;
          targets.push({
            id: bytes[o], x: i16(o+1), y: i16(o+3), z: i16(o+5),
            velocity: i16(o+7), snr: i16(o+9),
            classifier: bytes[o+11], posture: bytes[o+12], active: bytes[o+13],
          });
        }
        return targets;
      } catch (e) { return []; }
    };

    const parseGrid = (gridString) => {
      if (!gridString || gridString.length !== 56) {
        return Array(14).fill(null).map(() => Array(14).fill(0));
      }
      const grid = [];
      for (let y = 0; y < 14; y++) {
        grid[y] = [];
        const rowBits = parseInt(gridString.substr(y * 4, 4), 16);
        for (let x = 0; x < 14; x++) grid[y][x] = (rowBits >> (13 - x)) & 1;
      }
      return grid;
    };

    const mapConfig = this.mapConfig || {};
    const zones = [];
    if (mapConfig.zones && Array.isArray(mapConfig.zones)) {
      mapConfig.zones.forEach((zc, i) => {
        let occupancy = false;
        if (zc.presence_sensor) {
          occupancy = getState(`binary_sensor.${zc.presence_sensor}`) === "on";
        }
        zones.push({
          id: zc.presence_sensor || `zone_${i}`,
          // Radar-level numeric zone id (what api_set_zone_grid expects). Fall
          // back to i+1 for firmware predating the id field in get_map_config.
          _rawId: typeof zc.id === 'number' ? zc.id : (i + 1),
          name: zc.name || (zc.presence_sensor || `Zone ${i+1}`).replace(/^.*_/, '').replace(/_/g, ' '),
          map: parseGrid(zc.grid),
          occupancy,
        });
      });
    }

    const targetsBase64 = getState(`${prefix}_targets`);
    const globalPresence = getState(`binary_sensor.${deviceName}_global_presence`);
    const totalPeople = getState(`${prefix}_total_people`);

    const result = {
      edgeLabelGrid: parseGrid(mapConfig.edge_grid),
      entryExitGrid: parseGrid(mapConfig.exit_grid),
      interferenceGrid: parseGrid(mapConfig.interference_grid),
      mountingPosition: mapConfig.mounting_position || "wall",
      zones,
      targets: decodeTargets(targetsBase64),
      globalPresence: globalPresence === "on",
      totalPeople: totalPeople ? parseFloat(totalPeople) : 0,
    };

    // If we're editing a layer, overlay the working copy so the renderer
    // draws what the user is painting, not the last-committed state.
    if (this.editMode && this.pendingGrid) {
      if (this.editMode === 'edge')         result.edgeLabelGrid    = this.pendingGrid;
      else if (this.editMode === 'interference') result.interferenceGrid = this.pendingGrid;
      else if (this.editMode === 'entry_exit')   result.entryExitGrid    = this.pendingGrid;
      else if (this.editMode.type === 'zone') {
        const z = result.zones.find(z => z._rawId === this.editMode.id);
        if (z) z.map = this.pendingGrid;
      }
    }
    return result;
  }

  renderCanvas(data) {
    const containerWidth = this.content.clientWidth;
    if (!containerWidth) return;

    // Invalidate cached computed style on resize
    this._computedStyle = null;

    const dpr = window.devicePixelRatio || 1;
    let minX = 0, maxX = 13, minY = 0, maxY = 13;

    if (this.displayMode === "zoomed") {
      let found = false;
      minX = 13; maxX = 0; minY = 13; maxY = 0;
      for (let y = 0; y < 14; y++) {
        for (let x = 0; x < 14; x++) {
          if (!data.edgeLabelGrid[y][x]) {
            found = true;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
        }
      }
      if (!found) { minX = 0; maxX = 13; minY = 0; maxY = 13; }
    }

    const gridWidth = maxX - minX + 1;
    const gridHeight = maxY - minY + 1;
    const idealCellSize = containerWidth / gridWidth;
    const canvasWidth = containerWidth;
    // Cap canvas height to prevent overflow on mobile (max 65% of viewport)
    const maxCanvasHeight = window.innerHeight * 0.65;
    const idealHeight = idealCellSize * gridHeight;
    const canvasHeight = Math.min(idealHeight, maxCanvasHeight);
    const cellSize = canvasHeight / gridHeight;

    this.canvas.width = canvasWidth * dpr;
    this.canvas.height = canvasHeight * dpr;
    this.canvas.style.width = `${canvasWidth}px`;
    this.canvas.style.height = `${canvasHeight}px`;
    this.ctx.scale(dpr, dpr);

    this.renderParams = { minX, maxX, minY, maxY, cellSize, canvasWidth, canvasHeight };

    // Background
    const bgColor = this._resolveColor('--card-background-color', '#1c1c1c');
    this.ctx.fillStyle = bgColor;
    this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Draw layers
    this.drawBaseGrid(data, minX, maxX, minY, maxY, cellSize);
    this.drawEdgeLabels(data, minX, maxX, minY, maxY, cellSize);
    this.drawInterferenceSources(data, minX, maxX, minY, maxY, cellSize);
    this.drawEntryExitZones(data, minX, maxX, minY, maxY, cellSize);
    this.drawDetectionZones(data, minX, maxX, minY, maxY, cellSize);
    this.drawTargets(data, minX, maxX, minY, maxY, cellSize);
    if (this.showSensorPosition) {
      this.drawSensorPosition(data, minX, maxX, minY, maxY, cellSize);
    }
  }

  drawBaseGrid(data, minX, maxX, minY, maxY, cellSize) {
    if (!this.showGrid) return;
    this.ctx.strokeStyle = "rgba(255,255,255,0.06)";
    this.ctx.lineWidth = 0.5;
    for (let y = minY; y <= maxY + 1; y++) {
      const yPos = (y - minY) * cellSize;
      this.ctx.beginPath(); this.ctx.moveTo(0, yPos); this.ctx.lineTo((maxX - minX + 1) * cellSize, yPos); this.ctx.stroke();
    }
    for (let x = minX; x <= maxX + 1; x++) {
      const xPos = (x - minX) * cellSize;
      this.ctx.beginPath(); this.ctx.moveTo(xPos, 0); this.ctx.lineTo(xPos, (maxY - minY + 1) * cellSize); this.ctx.stroke();
    }
  }

  drawEdgeLabels(data, minX, maxX, minY, maxY, cellSize) {
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!data.edgeLabelGrid[y][x]) continue;
        const xPos = (x - minX) * cellSize;
        const yPos = (y - minY) * cellSize;
        // Subtle dark fill for out-of-bounds
        this.ctx.fillStyle = "rgba(0,0,0,0.3)";
        this.ctx.fillRect(xPos, yPos, cellSize, cellSize);
        // Diagonal hash
        this.ctx.strokeStyle = "rgba(255,255,255,0.05)";
        this.ctx.lineWidth = 0.5;
        this.ctx.beginPath();
        this.ctx.moveTo(xPos, yPos); this.ctx.lineTo(xPos + cellSize, yPos + cellSize);
        this.ctx.stroke();
      }
    }
  }

  drawInterferenceSources(data, minX, maxX, minY, maxY, cellSize) {
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!data.interferenceGrid[y][x]) continue;
        const xPos = (x - minX) * cellSize;
        const yPos = (y - minY) * cellSize;
        this.ctx.fillStyle = "rgba(244,67,54,0.25)";
        this.ctx.fillRect(xPos, yPos, cellSize, cellSize);
        // X pattern for interference
        this.ctx.strokeStyle = "rgba(244,67,54,0.4)";
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(xPos + 2, yPos + 2); this.ctx.lineTo(xPos + cellSize - 2, yPos + cellSize - 2);
        this.ctx.moveTo(xPos + cellSize - 2, yPos + 2); this.ctx.lineTo(xPos + 2, yPos + cellSize - 2);
        this.ctx.stroke();
      }
    }
  }

  drawEntryExitZones(data, minX, maxX, minY, maxY, cellSize) {
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!data.entryExitGrid[y][x]) continue;
        const xPos = (x - minX) * cellSize;
        const yPos = (y - minY) * cellSize;
        this.ctx.fillStyle = "rgba(76,175,80,0.15)";
        this.ctx.fillRect(xPos, yPos, cellSize, cellSize);
        this.ctx.strokeStyle = "rgba(76,175,80,0.5)";
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(xPos + 1, yPos + 1, cellSize - 2, cellSize - 2);
      }
    }
  }

  drawDetectionZones(data, minX, maxX, minY, maxY, cellSize) {
    data.zones.forEach((zone) => {
      const occupied = zone.occupancy;
      const fillColor = occupied ? "rgba(66,165,245,0.35)" : "rgba(66,165,245,0.08)";
      const borderColor = occupied ? "rgba(33,150,243,0.9)" : "rgba(33,150,243,0.25)";

      // Collect zone cells and find bounds
      let zMinX = 14, zMaxX = -1, zMinY = 14, zMaxY = -1;
      for (let y = 0; y < 14; y++) {
        for (let x = 0; x < 14; x++) {
          if (zone.map[y][x]) {
            zMinX = Math.min(zMinX, x); zMaxX = Math.max(zMaxX, x);
            zMinY = Math.min(zMinY, y); zMaxY = Math.max(zMaxY, y);
          }
        }
      }

      // Fill zone cells
      this.ctx.fillStyle = fillColor;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (zone.map[y][x]) {
            this.ctx.fillRect((x - minX) * cellSize, (y - minY) * cellSize, cellSize, cellSize);
          }
        }
      }

      // Draw clean outer border around the zone bounding box
      if (zMinX <= zMaxX && zMinX >= minX && zMaxX <= maxX && zMinY >= minY && zMaxY <= maxY) {
        const bx = (zMinX - minX) * cellSize;
        const by = (zMinY - minY) * cellSize;
        const bw = (zMaxX - zMinX + 1) * cellSize;
        const bh = (zMaxY - zMinY + 1) * cellSize;
        this.ctx.strokeStyle = borderColor;
        this.ctx.lineWidth = occupied ? 2.5 : 1.5;
        this.ctx.setLineDash(occupied ? [] : [4, 4]);
        this.ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
        this.ctx.setLineDash([]);

        // Zone label
        if (this.showZoneLabels) {
          const cx = bx + bw / 2;
          const cy = by + bh / 2;
          const label = zone.name || zone.id;
          const fontSize = Math.min(cellSize * 0.5, 14);
          this.ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          const tw = this.ctx.measureText(label).width;
          const pad = 6;

          // Label background pill
          const rx = cx - tw / 2 - pad;
          const ry = cy - fontSize / 2 - pad / 2;
          const rw = tw + pad * 2;
          const rh = fontSize + pad;
          const r = rh / 2;
          this.ctx.fillStyle = occupied ? "rgba(33,150,243,0.85)" : "rgba(33,150,243,0.4)";
          this.ctx.beginPath();
          this.ctx.moveTo(rx + r, ry);
          this.ctx.lineTo(rx + rw - r, ry);
          this.ctx.arcTo(rx + rw, ry, rx + rw, ry + r, r);
          this.ctx.lineTo(rx + rw, ry + rh - r);
          this.ctx.arcTo(rx + rw, ry + rh, rx + rw - r, ry + rh, r);
          this.ctx.lineTo(rx + r, ry + rh);
          this.ctx.arcTo(rx, ry + rh, rx, ry + rh - r, r);
          this.ctx.lineTo(rx, ry + r);
          this.ctx.arcTo(rx, ry, rx + r, ry, r);
          this.ctx.closePath();
          this.ctx.fill();

          this.ctx.fillStyle = "#fff";
          this.ctx.fillText(label, cx, cy);
        }
      }
    });
  }

  drawTargets(data, minX, maxX, minY, maxY, cellSize) {
    if (!data.targets || !data.targets.length) return;

    const postureIcons = { 0: "\u{1F9CD}", 1: "\u{1F9CE}", 2: "\u{1F6CC}" }; // standing, kneeling, sleeping
    const postureLabels = { 0: "Standing", 1: "Sitting", 2: "Lying" };

    data.targets.forEach((target) => {
      const gridX = (-target.x + 400) / 800.0 * 14.0;
      const gridY = target.y / 800.0 * 14.0;
      if (gridX < minX || gridX > maxX + 1 || gridY < minY || gridY > maxY + 1) return;

      const xPos = (gridX - minX) * cellSize;
      const yPos = (gridY - minY) * cellSize;
      const radius = Math.min(cellSize * 0.35, 18);

      // Glow effect
      const gradient = this.ctx.createRadialGradient(xPos, yPos, 0, xPos, yPos, radius * 2.5);
      gradient.addColorStop(0, "rgba(255,152,0,0.3)");
      gradient.addColorStop(1, "rgba(255,152,0,0)");
      this.ctx.fillStyle = gradient;
      this.ctx.beginPath();
      this.ctx.arc(xPos, yPos, radius * 2.5, 0, Math.PI * 2);
      this.ctx.fill();

      // Target circle
      this.ctx.fillStyle = "rgba(255,152,0,0.9)";
      this.ctx.strokeStyle = "rgba(255,111,0,1)";
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.arc(xPos, yPos, radius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();

      // Posture icon or ID
      const fontSize = Math.min(cellSize * 0.45, 14);
      this.ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillStyle = "#000";

      const posture = target.posture;
      if (posture in postureLabels) {
        // Show posture initial: S(tanding), s(itting), L(ying)
        const initials = { 0: "S", 1: "s", 2: "L" };
        this.ctx.fillText(initials[posture] || target.id, xPos, yPos);
      } else {
        this.ctx.fillText(target.id, xPos, yPos);
      }

      // Velocity indicator (small arrow showing movement direction)
      if (Math.abs(target.velocity) > 5) {
        const speed = Math.min(Math.abs(target.velocity) / 100, 1);
        const arrowLen = radius * 1.5 * speed;
        const angle = target.velocity > 0 ? -Math.PI / 2 : Math.PI / 2; // towards/away from sensor
        this.ctx.strokeStyle = "rgba(255,255,255,0.7)";
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(xPos, yPos + radius + 2);
        this.ctx.lineTo(xPos, yPos + radius + 2 + arrowLen);
        this.ctx.stroke();
      }
    });
  }

  drawSensorPosition(data, minX, maxX, minY, maxY, cellSize) {
    let sensorX, sensorY;
    switch (data.mountingPosition) {
      case "left_upper_corner": case "left_corner": sensorX = 0; sensorY = 0; break;
      case "right_upper_corner": case "right_corner": sensorX = 14; sensorY = 0; break;
      case "wall": default: sensorX = 7; sensorY = 0; break;
    }
    if (sensorX < minX - 1 || sensorX > maxX + 1 || sensorY < minY - 1 || sensorY > maxY + 1) return;

    const xPos = (sensorX - minX) * cellSize;
    const yPos = (sensorY - minY) * cellSize;
    const size = cellSize * 0.3;

    // Radar wave arcs
    for (let i = 0; i < 3; i++) {
      this.ctx.strokeStyle = `rgba(244,67,54,${0.5 - i * 0.15})`;
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.arc(xPos, yPos, size + i * 7, 0, Math.PI);
      this.ctx.stroke();
    }

    // Sensor dot
    this.ctx.fillStyle = "#f44336";
    this.ctx.beginPath();
    this.ctx.arc(xPos, yPos, 4, 0, Math.PI * 2);
    this.ctx.fill();

    // Label
    this.ctx.font = "bold 10px system-ui, sans-serif";
    this.ctx.fillStyle = "rgba(244,67,54,0.9)";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "top";
    this.ctx.fillText("SENSOR", xPos, yPos + size + 22);
  }

  updateInfoPanel(data) {
    const activeZones = data.zones.filter(z => z.occupancy);
    const targetCount = data.targets ? data.targets.length : 0;
    const postureLabels = { 0: "Standing", 1: "Sitting", 2: "Lying" };

    let html = '';

    // Presence status
    const presClass = data.globalPresence ? "presence" : "no-presence";
    html += `<span class="fp2-stat"><span class="fp2-dot ${presClass}"></span>${data.globalPresence ? "Occupied" : "Clear"}</span>`;

    // People count
    if (data.totalPeople > 0) {
      html += `<span class="fp2-stat"><span class="fp2-dot target"></span>${data.totalPeople} ${data.totalPeople === 1 ? "person" : "people"}</span>`;
    }

    // Zone status
    data.zones.forEach(z => {
      const cls = z.occupancy ? "zone-on" : "zone-off";
      const name = z.name || z.id;
      html += `<span class="fp2-stat"><span class="fp2-dot ${cls}"></span>${name}</span>`;
    });

    // Target details
    if (targetCount > 0) {
      data.targets.forEach(t => {
        const posture = postureLabels[t.posture] || "?";
        html += `<span class="fp2-stat"><span class="fp2-dot target"></span>T${t.id}: ${posture}</span>`;
      });
    }

    this.infoPanel.innerHTML = html;
  }

  // --- Edit mode: toolbar / state helpers -----------------------------------

  // Called when the pencil button is clicked — toggles into/out of editing.
  // Defaults to 'edge' on first entry; on subsequent entries, returns to the
  // most recently edited layer if one exists.
  toggleEditMode() {
    if (this.editMode) return this.cancelEdit();
    this._rebuildLayerOptions();
    const initialLayer = this._lastEditLayer || 'edge';
    this._enterEditLayer(initialLayer);
  }

  // Rebuild the <select> contents to include current zones. Called whenever
  // edit mode is opened (zones may appear/disappear between compiles).
  _rebuildLayerOptions() {
    const sel = this.querySelector('.fp2-layer-select');
    if (!sel) return;
    const zones = (this.mapConfig && this.mapConfig.zones) || [];
    const entryCount = 3 + zones.length;
    if (sel.options.length === entryCount) return;   // nothing changed
    while (sel.options.length > 3) sel.remove(3);
    zones.forEach((z, i) => {
      const id = typeof z.id === 'number' ? z.id : (i + 1);
      const label = `Zone ${id}${z.presence_sensor ? ` (${z.presence_sensor})` : ''}`;
      const opt = document.createElement('option');
      opt.value = `zone:${id}`;
      opt.textContent = label;
      sel.appendChild(opt);
    });
  }

  setEditLayer(value) {
    if (this._isDirty()) {
      if (!confirm('Discard unsaved edits on current layer?')) {
        // Re-sync the select back to the active layer
        this._syncLayerSelect();
        return;
      }
    }
    this._enterEditLayer(value);
  }

  _enterEditLayer(value) {
    // Parse value — 'edge' | 'interference' | 'entry_exit' | 'zone:<id>'
    let mode;
    if (value.startsWith('zone:')) mode = { type: 'zone', id: parseInt(value.slice(5), 10) };
    else mode = value;

    // Take a fresh snapshot of the layer's *committed* state (no overlay).
    const prevEdit = this.editMode;
    this.editMode = null;
    const data = this.gatherEntityData();
    this.editMode = mode;
    this._lastEditLayer = value;

    let src;
    if (mode === 'edge')                src = data.edgeLabelGrid;
    else if (mode === 'interference')   src = data.interferenceGrid;
    else if (mode === 'entry_exit')     src = data.entryExitGrid;
    else if (mode.type === 'zone') {
      const z = data.zones.find(z => z._rawId === mode.id);
      src = z ? z.map : Array(14).fill(null).map(() => Array(14).fill(0));
    }
    this._originalGrid = src.map(row => [...row]);
    this.pendingGrid   = src.map(row => [...row]);
    this._paintedCells = null;
    this.painting = false;
    this._updateEditToolbar();
    this.classList.add('fp2-editing');
    this._doUpdate();
  }

  cancelEdit() {
    this.editMode = null;
    this.pendingGrid = null;
    this._originalGrid = null;
    this.painting = false;
    this._paintedCells = null;
    this._updateEditToolbar();
    this.classList.remove('fp2-editing');
    this._doUpdate();
  }

  _syncLayerSelect() {
    const sel = this.querySelector('.fp2-layer-select');
    if (!sel || !this.editMode) return;
    if (typeof this.editMode === 'string') sel.value = this.editMode;
    else if (this.editMode.type === 'zone') sel.value = `zone:${this.editMode.id}`;
  }

  _updateEditToolbar() {
    const toolbar = this.querySelector('.fp2-edit-toolbar');
    const editBtn = this.querySelector('.edit-toggle');
    const dirtyDot = this.querySelector('.fp2-dirty-dot');
    const applyBtn = this.querySelector('.fp2-apply-btn');
    if (toolbar) toolbar.hidden = !this.editMode;
    if (editBtn) editBtn.classList.toggle('active', !!this.editMode);
    if (dirtyDot) dirtyDot.classList.toggle('active', this._isDirty());
    if (applyBtn) {
      applyBtn.disabled = !this._isDirty() || this._applyInFlight;
    }
    this._syncLayerSelect();
    this._syncMountSelect();
  }

  // Mirror the live state of select.<device>_mounting_position into the
  // card's dropdown. Called on every toolbar update so a change made
  // elsewhere (HA UI, automation) stays reflected here.
  _syncMountSelect() {
    const sel = this.querySelector('.fp2-mount-select');
    if (!sel || !this._hass) return;
    const deviceName = this.config.entity_prefix.replace(/^[^.]+\./, '');
    const entity = `select.${deviceName}_mounting_position`;
    const st = this._hass.states[entity];
    if (st && st.state && sel.value !== st.state) {
      sel.value = st.state;
    }
  }

  _isDirty() {
    if (!this.pendingGrid || !this._originalGrid) return false;
    for (let y = 0; y < 14; y++) {
      for (let x = 0; x < 14; x++) {
        if (this.pendingGrid[y][x] !== this._originalGrid[y][x]) return true;
      }
    }
    return false;
  }

  // --- Edit mode: pointer handlers -----------------------------------------

  _pointerToCell(e) {
    if (!this.renderParams) return null;
    const rect = this.canvas.getBoundingClientRect();
    const { minX, maxX, minY, maxY, cellSize } = this.renderParams;
    const x = Math.floor((e.clientX - rect.left) / cellSize) + minX;
    const y = Math.floor((e.clientY - rect.top) / cellSize) + minY;
    if (x < 0 || x > 13 || y < 0 || y > 13) return null;
    if (x < minX || x > maxX || y < minY || y > maxY) return null;
    return { x, y };
  }

  handlePointerDown(e) {
    if (!this.editMode || !this.pendingGrid) return;
    const cell = this._pointerToCell(e);
    if (!cell) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    const prev = this.pendingGrid[cell.y][cell.x];
    this.paintMode = prev ? 'erase' : 'paint';
    this.painting = true;
    this._paintedCells = new Set([`${cell.x},${cell.y}`]);
    this.pendingGrid[cell.y][cell.x] = prev ? 0 : 1;
    this._updateEditToolbar();
    this._doUpdate();
  }

  handlePointerMove(e) {
    if (!this.painting || !this.pendingGrid) return;
    const cell = this._pointerToCell(e);
    if (!cell) return;
    const key = `${cell.x},${cell.y}`;
    if (this._paintedCells.has(key)) return;
    this._paintedCells.add(key);
    this.pendingGrid[cell.y][cell.x] = this.paintMode === 'paint' ? 1 : 0;
    this._updateEditToolbar();
    this._doUpdate();
  }

  handlePointerUp() {
    if (!this.painting) return;
    this.painting = false;
    this._paintedCells = null;
  }

  // --- Edit mode: apply / cancel -------------------------------------------

  async applyPendingGrid() {
    if (!this.editMode || !this.pendingGrid) return;
    if (!this._isDirty() || this._applyInFlight) return;
    this._applyInFlight = true;
    this._updateEditToolbar();

    const deviceName = this.config.entity_prefix.replace(/^[^.]+\./, '');
    const hex = this._gridTo56Hex(this.pendingGrid);
    let service, data;
    if (this.editMode === 'edge')              { service = `${deviceName}_set_edge_grid`;         data = { grid_hex: hex }; }
    else if (this.editMode === 'interference') { service = `${deviceName}_set_interference_grid`; data = { grid_hex: hex }; }
    else if (this.editMode === 'entry_exit')   { service = `${deviceName}_set_entry_exit_grid`;   data = { grid_hex: hex }; }
    else if (this.editMode.type === 'zone')    { service = `${deviceName}_set_zone_grid`;         data = { zone_id: this.editMode.id, grid_hex: hex }; }
    else { this._applyInFlight = false; this._updateEditToolbar(); return; }

    try {
      const resp = await this._hass.callService('esphome', service, data, undefined, undefined, true);
      const ok = resp && resp.response && resp.response.ok === true;
      if (ok) {
        this._flashCanvas('ok');
        // Refetch to pick up authoritative state (handles any server-side shaping)
        await this.fetchMapConfig();
        // New baseline = what the device now reports (or our pending if refetch
        // raced and editMode still set)
        this._originalGrid = this.pendingGrid.map(row => [...row]);
      } else {
        this._flashCanvas('err');
        const err = resp && resp.response && resp.response.error;
        console.error('[FP2 Card] set_grid rejected:', err || resp);
      }
    } catch (e) {
      this._flashCanvas('err');
      console.error('[FP2 Card] Apply failed:', e);
    } finally {
      this._applyInFlight = false;
      this._updateEditToolbar();
    }
  }

  _flashCanvas(kind) {
    if (!this.canvas) return;
    this.canvas.classList.remove('flash-ok', 'flash-err');
    // Force reflow to restart the transition
    void this.canvas.offsetWidth;
    this.canvas.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-err');
    setTimeout(() => {
      this.canvas && this.canvas.classList.remove('flash-ok', 'flash-err');
    }, 500);
  }

  // Mount position change — driven from the toolbar dropdown. Wrapped in a
  // confirm() because selecting here fires an immediate radar re-init on the
  // device (~15-30s during which zones/grids are re-sent). The HA-side entity
  // also fires the re-init, but this card-path at least protects against
  // accidental dropdown clicks in the Lovelace view.
  async handleMountChange(e) {
    const target = e.target;
    const newValue = target.value;
    const deviceName = this.config.entity_prefix.replace(/^[^.]+\./, '');
    const entity = `select.${deviceName}_mounting_position`;
    const cur = this._hass && this._hass.states[entity] && this._hass.states[entity].state;
    if (cur === newValue) return;

    const ok = window.confirm(
      `Change mount position from "${cur}" to "${newValue}"?\n\n` +
      `This triggers a full radar re-initialization (~15-30s). ` +
      `Zones, grids, and operating mode will be re-sent under the new orientation.`
    );
    if (!ok) {
      // Revert the dropdown to the pre-click value
      target.value = cur || 'Wall';
      return;
    }
    try {
      await this._hass.callService('select', 'select_option', {
        entity_id: entity,
        option: newValue,
      });
    } catch (err) {
      console.error('[FP2 Card] Mount change failed:', err);
      target.value = cur || 'Wall';
    }
  }

  // 14x14 grid of 0/1 → 56-char hex matching grid_to_hex_card_format in C++.
  // Each row is 4 hex chars of a 16-bit value; col c = bit (13 - c).
  _gridTo56Hex(grid) {
    let out = '';
    for (let y = 0; y < 14; y++) {
      let rowBits = 0;
      for (let x = 0; x < 14; x++) {
        if (grid[y][x]) rowBits |= (1 << (13 - x));
      }
      out += rowBits.toString(16).padStart(4, '0');
    }
    return out;
  }

  disconnectedCallback() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this._pendingUpdate) clearTimeout(this._pendingUpdate);
    if (this.autoTracking) this._disableTracking();
  }

  getCardSize() { return 8; }

  getGridOptions() {
    return { rows: "auto", columns: 6, min_rows: 4, max_rows: 12 };
  }
}

customElements.define("aqara-fp2-card", AqaraFP2Card);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "aqara-fp2-card",
  name: "Aqara FP2 Presence Sensor Card",
  description: "Visualizes Aqara FP2 presence sensor data with zones and target tracking",
  preview: true,
});
