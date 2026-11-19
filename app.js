// ============================================================================
// AMAZON DISPATCH — CONTROL DE HORAS + AUTO-SYNC CON GOOGLE DRIVE
// ============================================================================

const STORAGE_KEY = 'amazon_dispatch_timepro_v2';
const DRIVE_URL_KEY = 'amazon_dispatch_drive_webhook_url';
const DRIVE_SHEET_LINK_KEY = 'amazon_dispatch_drive_sheet_url';

// La semana empieza en DOMINGO (ej. Domingo 15 Nov a las 11:00 PM para amanecer Lunes)
const DAY_NAMES = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado'
];

const NEXT_DAY_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

const MONTH_NAMES_SHORT = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'
];

// Estado global
let appState = {
  theme: 'dark',
  rateBase: 10.00,
  currentWeekSunday: getSundayISO(new Date()),
  weeks: {}
};

const DEFAULT_DRIVE_URL = 'https://script.google.com/macros/s/AKfycbzyZeicT-TVPWVborJI55Uxsj2yVzWO9VcggeyZcr5G1JXVSyQlKgb3Qsk-N-cwHbF_/exec';
const DEFAULT_DRIVE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/19Y5AaxMHlWVcKscn4CSutNV19pZ9RJV6nOz5BLdcdnE/edit';

let driveConfig = {
  webhookUrl: localStorage.getItem(DRIVE_URL_KEY) || DEFAULT_DRIVE_URL,
  sheetUrl: localStorage.getItem(DRIVE_SHEET_LINK_KEY) || DEFAULT_DRIVE_SHEET_URL,
  syncStatus: 'idle' // 'idle' | 'syncing' | 'synced' | 'error'
};

let driveSyncDebounceTimer = null;

// ============================================================================
// UTILIDADES DE FECHAS Y HORAS
// ============================================================================

function parseISODateLocal(isoStr) {
  const [y, m, d] = isoStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toISODateLocal(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getSundayISO(dateObj) {
  const d = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  const day = d.getDay(); // 0 = Domingo
  d.setDate(d.getDate() - day);
  return toISODateLocal(d);
}

function addDaysISO(isoStr, daysToAdd) {
  const d = parseISODateLocal(isoStr);
  d.setDate(d.getDate() + daysToAdd);
  return toISODateLocal(d);
}

function formatReadableDate(isoStr) {
  const d = parseISODateLocal(isoStr);
  return `${d.getDate()} ${MONTH_NAMES_SHORT[d.getMonth()]}`;
}

function formatFullRange(sundayISO) {
  const saturdayISO = addDaysISO(sundayISO, 6);
  const dStart = parseISODateLocal(sundayISO);
  const dEnd = parseISODateLocal(saturdayISO);
  return `Dom ${dStart.getDate()} ${MONTH_NAMES_SHORT[dStart.getMonth()]} – Sáb ${dEnd.getDate()} ${MONTH_NAMES_SHORT[dEnd.getMonth()]}, ${dEnd.getFullYear()}`;
}

function timeToMinutes(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return null;
  const [h, m] = timeStr.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToTime(totalMinutes) {
  let mins = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function calculateDurationHours(startTime, endTime) {
  const startMins = timeToMinutes(startTime);
  const endMins = timeToMinutes(endTime);
  if (startMins === null || endMins === null) return 0;

  let diff = endMins - startMins;
  if (diff <= 0) {
    diff += 1440;
  }
  return Math.round((diff / 60) * 100) / 100;
}

// ============================================================================
// MODELO DE DATOS
// ============================================================================

function createEmptyDay(sundayISO, dayIndex) {
  return {
    dayIndex,
    dayName: DAY_NAMES[dayIndex],
    dateISO: addDaysISO(sundayISO, dayIndex),
    worked: false,
    startTime: '23:00',
    endTime: '08:00',
    baseHours: 0,
    extraShifts: [],
    notes: ''
  };
}

function createEmptyWeek(sundayISO) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    days.push(createEmptyDay(sundayISO, i));
  }
  return {
    sundayISO,
    rateBase: appState.rateBase || 10.0,
    days,
    updatedAt: new Date().toISOString()
  };
}

function ensureCurrentWeekExists() {
  const key = appState.currentWeekSunday;
  if (!appState.weeks[key]) {
    appState.weeks[key] = createEmptyWeek(key);
  } else {
    appState.weeks[key].days.forEach((d, idx) => {
      d.dayIndex = idx;
      d.dayName = DAY_NAMES[idx];
      d.dateISO = addDaysISO(key, idx);
      if (!Array.isArray(d.extraShifts)) {
        d.extraShifts = [];
      }
    });
  }
  return appState.weeks[key];
}

// ============================================================================
// GUARDADO LOCAL + AUTO-GUARDADO EN GOOGLE DRIVE
// ============================================================================

function loadState() {
  try {
    localStorage.removeItem('amazon_dispatch_timepro_v1');
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      appState = {
        ...appState,
        ...parsed,
        weeks: parsed.weeks || {}
      };
    }
  } catch (err) {
    console.error('Error al cargar:', err);
  }
  ensureCurrentWeekExists();
}

function saveState(toastMsg = null, skipDriveSync = false) {
  const week = ensureCurrentWeekExists();
  week.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  if (toastMsg) showToast(toastMsg);

  // Si Google Drive está conectado, guardar automáticamente en la nube tras cada cambio
  if (!skipDriveSync && driveConfig.webhookUrl) {
    scheduleDriveAutoSync();
  }
}

// Verifica si toda la web está en cero (ej. recién abierta en otro navegador o caché limpio)
function isLocalDataCompletelyEmpty() {
  const keys = Object.keys(appState.weeks || {});
  for (const k of keys) {
    const w = appState.weeks[k];
    if (!w || !Array.isArray(w.days)) continue;
    for (const d of w.days) {
      if (d.worked || (d.baseHours > 0) || (Array.isArray(d.extraShifts) && d.extraShifts.length > 0) || d.notes) {
        return false;
      }
    }
  }
  return true;
}

// ============================================================================
// SINCRONIZACIÓN AUTOMÁTICA CON GOOGLE DRIVE (APPS SCRIPT)
// ============================================================================

function updateDriveStatusUI(status, customText = null) {
  driveConfig.syncStatus = status;
  const btn = document.getElementById('btnOpenDriveModal');
  const label = document.getElementById('driveBtnLabel');
  const quickPullBtn = document.getElementById('btnQuickPullDrive');
  const modalStatusText = document.getElementById('modalDriveStatusText');
  const linkSheet = document.getElementById('linkOpenGoogleSheet');

  btn.classList.remove('connected', 'syncing');

  if (!driveConfig.webhookUrl) {
    label.textContent = '☁️ Conectar Google Drive';
    quickPullBtn.style.display = 'none';
    modalStatusText.textContent = '⚪ Sin conectar todavía';
    linkSheet.style.display = 'none';
    return;
  }

  quickPullBtn.style.display = 'inline-flex';
  const topOpenSheetBtn = document.getElementById('btnOpenDriveSheetTop');
  if (driveConfig.sheetUrl) {
    linkSheet.href = driveConfig.sheetUrl;
    linkSheet.style.display = 'inline-block';
    if (topOpenSheetBtn) {
      topOpenSheetBtn.href = driveConfig.sheetUrl;
      topOpenSheetBtn.style.display = 'inline-flex';
    }
  }

  if (status === 'syncing') {
    btn.classList.add('syncing');
    label.textContent = customText || '⏳ Guardando en Drive...';
    modalStatusText.textContent = '⏳ Sincronizando con Google Drive...';
  } else if (status === 'error') {
    label.textContent = '⚠️ Error Drive (Revisar)';
    modalStatusText.textContent = customText || '⚠️ No se pudo conectar con la URL de Google Drive';
  } else {
    btn.classList.add('connected');
    label.textContent = customText || '✅ Guardado en Drive';
    modalStatusText.textContent = '🟢 Conectado • Guardado automático activo';
  }
}

function scheduleDriveAutoSync() {
  if (!driveConfig.webhookUrl) return;
  updateDriveStatusUI('syncing', '⏳ Guardando en Drive...');
  if (driveSyncDebounceTimer) clearTimeout(driveSyncDebounceTimer);
  driveSyncDebounceTimer = setTimeout(() => {
    pushStateToGoogleDrive(false);
  }, 1100);
}

async function pushStateToGoogleDrive(showNotification = false) {
  if (!driveConfig.webhookUrl) {
    if (showNotification) showToast('⚠️ Primero pega tu enlace de Google Drive');
    return;
  }

  updateDriveStatusUI('syncing', '⏳ Guardando en Drive...');
  const payloadStr = JSON.stringify({
    action: 'save_state',
    state: appState
  });

  try {
    const response = await fetch(driveConfig.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: payloadStr
    });

    const resData = await response.json();
    if (resData && resData.ok) {
      if (resData.spreadsheetUrl) {
        driveConfig.sheetUrl = resData.spreadsheetUrl;
        localStorage.setItem(DRIVE_SHEET_LINK_KEY, resData.spreadsheetUrl);
      }
      updateDriveStatusUI('synced', '✅ Guardado en Drive');
      if (showNotification) {
        showToast('☁️ Guardado en la hoja de Google Drive con éxito');
      }
      return;
    } else {
      throw new Error(resData?.error || 'Respuesta inválida de Drive');
    }
  } catch (firstErr) {
    // Si la página se abrió como archivo local (file://), el navegador puede bloquear la lectura de respuesta POST por CORS aunque sí envíe los datos.
    try {
      await fetch(driveConfig.webhookUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: payloadStr
      });

      // Verificar con GET que el script tenga permiso público ("Cualquier persona")
      const checkRes = await fetch(driveConfig.webhookUrl, { method: 'GET' });
      const checkData = await checkRes.json();
      if (checkData && checkData.ok) {
        if (checkData.spreadsheetUrl) {
          driveConfig.sheetUrl = checkData.spreadsheetUrl;
          localStorage.setItem(DRIVE_SHEET_LINK_KEY, checkData.spreadsheetUrl);
        }
        updateDriveStatusUI('synced', '✅ Guardado en Drive');
        if (showNotification) {
          showToast('☁️ Guardado en la hoja de Google Drive con éxito');
        }
        return;
      }
    } catch (secondErr) {
      console.error('Error al guardar en Google Drive:', secondErr);
    }

    updateDriveStatusUI('error', '⚠️ Error al guardar en Drive');
    if (showNotification) {
      alert('Google devolvió "Acceso denegado (403)". En Apps Script asegúrate de:\n1. Pulsar el icono de Guardar 💾 (Ctrl+S).\n2. En Implementar -> Gestionar implementaciones -> Editar (✏️), elegir versión "Nueva versión" y en Quién tiene acceso elegir exactamente "Cualquier persona" (no "Cualquier usuario con cuenta de Google").');
    }
  }
}

async function pullStateFromGoogleDrive(showNotification = true) {
  if (!driveConfig.webhookUrl) {
    if (showNotification) showToast('⚠️ Primero conecta tu enlace de Google Drive');
    return;
  }

  updateDriveStatusUI('syncing', '⏳ Cargando de Drive...');

  try {
    const response = await fetch(driveConfig.webhookUrl, {
      method: 'GET'
    });
    const resData = await response.json();

    if (resData && resData.ok && resData.data) {
      if (resData.spreadsheetUrl) {
        driveConfig.sheetUrl = resData.spreadsheetUrl;
        localStorage.setItem(DRIVE_SHEET_LINK_KEY, resData.spreadsheetUrl);
      }

      const incoming = resData.data;
      if (incoming.weeks && Object.keys(incoming.weeks).length > 0) {
        appState.weeks = incoming.weeks;
        if (incoming.rateBase) appState.rateBase = Number(incoming.rateBase);
        if (incoming.currentWeekSunday && incoming.weeks[incoming.currentWeekSunday]) {
          appState.currentWeekSunday = incoming.currentWeekSunday;
        }
        ensureCurrentWeekExists();
        saveState(null, true); // Guardar localmente sin volver a disparar POST
        renderAll();
        updateDriveStatusUI('synced', '✅ Drive Sincronizado');
        if (showNotification) {
          showToast('📥 Datos recuperados desde Google Drive');
        }
      } else {
        updateDriveStatusUI('synced', '✅ Drive Conectado');
        if (showNotification) {
          showToast('☁️ La hoja de Google Drive está conectada (aún sin horas guardadas)');
        }
      }
    } else {
      throw new Error(resData?.error || 'No se recibieron datos válidos');
    }
  } catch (err) {
    console.error('Error al importar desde Google Drive:', err);
    updateDriveStatusUI('error', '⚠️ Error al leer Drive');
    if (showNotification) {
      alert('No se pudo cargar desde Google Drive. Verifica que la URL de Apps Script sea correcta.');
    }
  }
}

// ============================================================================
// CÁLCULOS
// ============================================================================

function getDayExtraHoursTotal(day) {
  if (!Array.isArray(day.extraShifts)) return 0;
  const sum = day.extraShifts.reduce((acc, s) => acc + (Number(s.hours) || 0), 0);
  return Math.round(sum * 100) / 100;
}

function computeWeekTotals(weekObj) {
  const rate = Number(weekObj.rateBase ?? appState.rateBase ?? 10);
  let totalBaseHours = 0;
  let totalExtraHours = 0;

  weekObj.days.forEach((day) => {
    const bHours = day.worked ? (Number(day.baseHours) || 0) : 0;
    const eHours = getDayExtraHoursTotal(day);
    totalBaseHours += bHours;
    totalExtraHours += eHours;
  });

  totalBaseHours = Math.round(totalBaseHours * 100) / 100;
  totalExtraHours = Math.round(totalExtraHours * 100) / 100;
  const totalHours = Math.round((totalBaseHours + totalExtraHours) * 100) / 100;
  const totalPay = Math.round(totalHours * rate * 100) / 100;

  return {
    rate,
    totalBaseHours,
    totalExtraHours,
    totalHours,
    totalPay
  };
}

// ============================================================================
// RENDERIZADO
// ============================================================================

function applyTheme() {
  if (appState.theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    document.getElementById('themeIcon').textContent = '🌙';
  } else {
    document.documentElement.removeAttribute('data-theme');
    document.getElementById('themeIcon').textContent = '☀️';
  }
}

function formatNumClean(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

function renderAll() {
  applyTheme();
  const week = ensureCurrentWeekExists();
  const stats = computeWeekTotals(week);

  document.getElementById('rateBaseInput').value = stats.rate;
  document.getElementById('rateLabelText').textContent = formatNumClean(stats.rate);
  document.getElementById('weekRangeText').textContent = formatFullRange(week.sundayISO);
  document.getElementById('weekDatePicker').value = week.sundayISO;

  document.getElementById('kpiBaseHours').textContent = `${formatNumClean(stats.totalBaseHours)} h`;
  document.getElementById('kpiExtraHours').textContent = `${formatNumClean(stats.totalExtraHours)} h`;
  document.getElementById('kpiTotalHours').textContent = `${formatNumClean(stats.totalHours)} h`;
  document.getElementById('kpiTotalPay').textContent = `$${stats.totalPay.toFixed(2)}`;

  renderDays(week, stats.rate);
  renderSavedWeeks();
}

function renderDays(week, rate) {
  const container = document.getElementById('daysContainer');

  container.innerHTML = week.days.map((day, idx) => {
    const bHours = day.worked ? (Number(day.baseHours) || 0) : 0;
    const eHours = getDayExtraHoursTotal(day);
    const totalDayHours = Math.round((bHours + eHours) * 100) / 100;
    const totalDayPay = Math.round(totalDayHours * rate * 100) / 100;
    const isActive = day.worked || day.extraShifts.length > 0;
    const nextDayLabel = NEXT_DAY_SHORT[idx];

    const mainShiftHTML = day.worked
      ? `
        <div class="shift-row">
          <span class="shift-tag">🌙 Turno Noche</span>
          <div class="time-pair">
            <span>De</span>
            <input type="time" class="input-time" value="${day.startTime}"
              onchange="onMainTimeChange(${idx}, 'startTime', this.value)" />
            <span>a (${nextDayLabel})</span>
            <input type="time" class="input-time" value="${day.endTime}"
              onchange="onMainTimeChange(${idx}, 'endTime', this.value)" />
          </div>

          <div class="time-pair">
            <span>Horas:</span>
            <input type="number" step="0.25" min="0" max="24" class="input-hours"
              value="${bHours}"
              onchange="onDirectBaseHours(${idx}, this.value)" />
          </div>

          <div class="quick-chips">
            <button type="button" class="chip" onclick="adjustMainShift(${idx}, -30)" title="Salí 30 min antes">-30m</button>
            <button type="button" class="chip" onclick="resetMainShift(${idx})" title="Restaurar 11 PM a 8 AM (9h)">9h</button>
            <button type="button" class="chip" onclick="adjustMainShift(${idx}, 30)" title="Me quedé 30 min más">+30m</button>
            <button type="button" class="chip" onclick="adjustMainShift(${idx}, 60)" title="Me quedé 1 hora más">+1h</button>
          </div>

          <button type="button" class="btn-remove-block" onclick="deactivateMainShift(${idx})" title="Quitar turno de este día">✕</button>
        </div>
      `
      : `
        <button type="button" class="btn-activate-shift" onclick="activateMainShift(${idx})">
          + Activar turno (${day.dayName} 11:00 PM → ${nextDayLabel} 8:00 AM)
        </button>
      `;

    const extraShiftsHTML = day.extraShifts.map((ex, exIdx) => `
      <div class="shift-row extra-row">
        <span class="extra-tag">🚀 Extra #${exIdx + 1}</span>
        <div class="time-pair">
          <span>De</span>
          <input type="time" class="input-time" value="${ex.startTime || ''}"
            onchange="onExtraShiftTime(${idx}, ${exIdx}, 'startTime', this.value)" />
          <span>a</span>
          <input type="time" class="input-time" value="${ex.endTime || ''}"
            onchange="onExtraShiftTime(${idx}, ${exIdx}, 'endTime', this.value)" />
        </div>

        <div class="time-pair">
          <span>Horas:</span>
          <input type="number" step="0.25" min="0" max="24" class="input-hours input-hours-extra"
            value="${ex.hours || 0}"
            onchange="onExtraShiftHours(${idx}, ${exIdx}, this.value)" />
        </div>

        <div class="quick-chips">
          <button type="button" class="chip" onclick="adjustExtraShiftHours(${idx}, ${exIdx}, 0.5)">+30m</button>
          <button type="button" class="chip" onclick="adjustExtraShiftHours(${idx}, ${exIdx}, 1)">+1h</button>
          <button type="button" class="chip" onclick="adjustExtraShiftHours(${idx}, ${exIdx}, 2)">+2h</button>
        </div>

        <button type="button" class="btn-remove-block" onclick="removeExtraShift(${idx}, ${exIdx})" title="Eliminar este horario extra">✕</button>
      </div>
    `).join('');

    const addExtraBtnLabel = day.extraShifts.length === 0
      ? '+ Añadir hora extra en otro horario'
      : '+ Añadir nueva hora extra en otro horario';

    return `
      <div class="day-card ${isActive ? 'active-day' : ''}">
        <div class="day-main-row">
          <div class="day-info">
            <div class="day-title">
              <span class="day-name">${day.dayName}</span>
              <span class="day-date-text">${formatReadableDate(day.dateISO)}</span>
            </div>
            <span class="shift-hint">Noche del ${day.dayName.toLowerCase()} al ${nextDayLabel.toLowerCase()}</span>
          </div>

          <div class="day-controls">
            ${mainShiftHTML}
            ${extraShiftsHTML}

            <div class="day-bottom-actions">
              <button type="button" class="btn-add-extra-inline" onclick="addExtraShift(${idx})">
                ${addExtraBtnLabel}
              </button>

              ${isActive || day.notes ? `
                <input
                  type="text"
                  class="input-note-inline"
                  placeholder="Añadir nota opcional..."
                  value="${escapeHtml(day.notes || '')}"
                  onchange="onNoteChange(${idx}, this.value)"
                />
              ` : ''}
            </div>
          </div>

          <div class="day-total-col">
            <div class="day-pay mono ${totalDayPay === 0 ? 'zero' : ''}">$${totalDayPay.toFixed(2)}</div>
            <div class="day-hours mono">${formatNumClean(totalDayHours)} hrs</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderSavedWeeks() {
  const container = document.getElementById('savedWeeksList');
  const keys = Object.keys(appState.weeks).sort().reverse();
  if (keys.length <= 1) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `<span style="font-size:0.76rem;color:var(--text-muted);">Semanas:</span>` +
    keys.map((k) => {
      const w = appState.weeks[k];
      const st = computeWeekTotals(w);
      const isCurr = k === appState.currentWeekSunday;
      return `
        <button type="button" class="week-chip ${isCurr ? 'active' : ''}" onclick="selectWeek('${k}')">
          Dom ${formatReadableDate(k)} ($${st.totalPay.toFixed(0)})
        </button>
      `;
    }).join('');
}

// ============================================================================
// ACCIONES DEL USUARIO
// ============================================================================

window.activateMainShift = function(dayIdx) {
  const week = ensureCurrentWeekExists();
  const day = week.days[dayIdx];
  day.worked = true;
  day.startTime = day.startTime || '23:00';
  day.endTime = day.endTime || '08:00';
  day.baseHours = calculateDurationHours(day.startTime, day.endTime);
  saveState();
  renderAll();
};

window.deactivateMainShift = function(dayIdx) {
  const week = ensureCurrentWeekExists();
  const day = week.days[dayIdx];
  day.worked = false;
  day.baseHours = 0;
  saveState();
  renderAll();
};

window.onMainTimeChange = function(dayIdx, field, value) {
  const week = ensureCurrentWeekExists();
  const day = week.days[dayIdx];
  day[field] = value;
  day.worked = true;
  day.baseHours = calculateDurationHours(day.startTime, day.endTime);
  saveState();
  renderAll();
};

window.onDirectBaseHours = function(dayIdx, val) {
  const week = ensureCurrentWeekExists();
  const day = week.days[dayIdx];
  const hrs = Math.max(0, Math.min(24, parseFloat(val) || 0));
  day.baseHours = Math.round(hrs * 100) / 100;
  day.worked = day.baseHours > 0;
  const startMins = timeToMinutes(day.startTime || '23:00');
  if (startMins !== null && day.baseHours > 0) {
    day.endTime = minutesToTime(startMins + Math.round(day.baseHours * 60));
  }
  saveState();
  renderAll();
};

window.adjustMainShift = function(dayIdx, deltaMins) {
  const week = ensureCurrentWeekExists();
  const day = week.days[dayIdx];
  day.worked = true;
  const endMins = timeToMinutes(day.endTime || '08:00');
  day.endTime = minutesToTime(endMins + deltaMins);
  day.baseHours = calculateDurationHours(day.startTime || '23:00', day.endTime);
  saveState();
  renderAll();
};

window.resetMainShift = function(dayIdx) {
  const week = ensureCurrentWeekExists();
  const day = week.days[dayIdx];
  day.worked = true;
  day.startTime = '23:00';
  day.endTime = '08:00';
  day.baseHours = 9;
  saveState();
  renderAll();
};

window.addExtraShift = function(dayIdx) {
  const week = ensureCurrentWeekExists();
  const day = week.days[dayIdx];
  day.extraShifts.push({
    startTime: '14:00',
    endTime: '15:00',
    hours: 1
  });
  saveState();
  renderAll();
};

window.removeExtraShift = function(dayIdx, exIdx) {
  const week = ensureCurrentWeekExists();
  const day = week.days[dayIdx];
  day.extraShifts.splice(exIdx, 1);
  saveState();
  renderAll();
};

window.onExtraShiftTime = function(dayIdx, exIdx, field, val) {
  const week = ensureCurrentWeekExists();
  const ex = week.days[dayIdx].extraShifts[exIdx];
  if (!ex) return;
  ex[field] = val;
  if (ex.startTime && ex.endTime) {
    ex.hours = calculateDurationHours(ex.startTime, ex.endTime);
  }
  saveState();
  renderAll();
};

window.onExtraShiftHours = function(dayIdx, exIdx, val) {
  const week = ensureCurrentWeekExists();
  const ex = week.days[dayIdx].extraShifts[exIdx];
  if (!ex) return;
  const hrs = Math.max(0, Math.min(24, parseFloat(val) || 0));
  ex.hours = Math.round(hrs * 100) / 100;
  const startMins = timeToMinutes(ex.startTime);
  if (startMins !== null && ex.hours > 0) {
    ex.endTime = minutesToTime(startMins + Math.round(ex.hours * 60));
  }
  saveState();
  renderAll();
};

window.adjustExtraShiftHours = function(dayIdx, exIdx, deltaHours) {
  const week = ensureCurrentWeekExists();
  const ex = week.days[dayIdx].extraShifts[exIdx];
  if (!ex) return;
  ex.hours = Math.round(((Number(ex.hours) || 0) + deltaHours) * 100) / 100;
  const startMins = timeToMinutes(ex.startTime);
  if (startMins !== null && ex.hours > 0) {
    ex.endTime = minutesToTime(startMins + Math.round(ex.hours * 60));
  }
  saveState();
  renderAll();
};

window.onNoteChange = function(dayIdx, text) {
  const week = ensureCurrentWeekExists();
  week.days[dayIdx].notes = text;
  saveState();
};

window.selectWeek = function(sundayISO) {
  appState.currentWeekSunday = sundayISO;
  ensureCurrentWeekExists();
  saveState();
  renderAll();
};

// ============================================================================
// EXPORTAR E IMPORTAR EXCEL (.XLSX) LOCAL
// ============================================================================

async function exportToExcel() {
  if (typeof ExcelJS === 'undefined') {
    alert('ExcelJS aún está cargando.');
    return;
  }

  const week = ensureCurrentWeekExists();
  const stats = computeWeekTotals(week);
  const rangeStr = formatFullRange(week.sundayISO);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Horas Semana', {
    views: [{ showGridLines: true }]
  });

  sheet.columns = [
    { width: 14 }, // A: Día
    { width: 14 }, // B: Fecha
    { width: 14 }, // C: Entrada Turno
    { width: 14 }, // D: Salida Turno
    { width: 16 }, // E: Horas Turno
    { width: 26 }, // F: Detalle Otros Horarios
    { width: 16 }, // G: Horas Extras
    { width: 16 }, // H: Total Horas
    { width: 16 }, // I: Pago del Día ($)
    { width: 32 }  // J: Notas
  ];

  sheet.mergeCells('A1:J1');
  const title = sheet.getCell('A1');
  title.value = `⚡ AMAZON DISPATCH — CONTROL DE HORAS (${rangeStr})`;
  title.font = { name: 'Segoe UI', size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
  title.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  sheet.getRow(1).height = 30;

  sheet.getRow(3).height = 22;
  sheet.getCell('A3').value = 'Inicio (Dom):';
  sheet.getCell('A3').font = { bold: true };
  sheet.getCell('B3').value = week.sundayISO;

  sheet.getCell('D3').value = 'Pago por Hora ($):';
  sheet.getCell('D3').font = { bold: true };
  sheet.getCell('E3').value = stats.rate;
  sheet.getCell('E3').numFmt = '$#,##0.00';
  sheet.getCell('E3').font = { bold: true, color: { argb: 'FF047857' } };
  sheet.getCell('E3').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };

  const headers = [
    'Día', 'Fecha', 'Entrada', 'Salida', 'Horas Turno',
    'Otros Horarios (Extras)', 'Horas Extras', 'Total Horas', 'Pago Día ($)', 'Notas'
  ];
  const headerRow = sheet.getRow(5);
  headerRow.values = headers;
  headerRow.height = 25;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  week.days.forEach((day, idx) => {
    const rIdx = 6 + idx;
    const row = sheet.getRow(rIdx);
    row.height = 23;

    const bHours = day.worked ? (Number(day.baseHours) || 0) : 0;
    const eHours = getDayExtraHoursTotal(day);
    const totH = Math.round((bHours + eHours) * 100) / 100;
    const totP = Math.round(totH * stats.rate * 100) / 100;

    const extraDesc = day.extraShifts
      .map(ex => `${ex.startTime || ''}-${ex.endTime || ''} (${ex.hours}h)`)
      .join(', ');

    row.getCell(1).value = day.dayName;
    row.getCell(2).value = day.dateISO;
    row.getCell(3).value = day.worked ? day.startTime : '-';
    row.getCell(4).value = day.worked ? day.endTime : '-';

    row.getCell(5).value = bHours;
    row.getCell(5).numFmt = '0.00';

    row.getCell(6).value = extraDesc || '-';

    row.getCell(7).value = eHours;
    row.getCell(7).numFmt = '0.00';

    row.getCell(8).value = { formula: `E${rIdx}+G${rIdx}`, result: totH };
    row.getCell(8).numFmt = '0.00';

    row.getCell(9).value = { formula: `H${rIdx}*$E$3`, result: totP };
    row.getCell(9).numFmt = '$#,##0.00';

    row.getCell(10).value = day.notes || '';

    for (let c = 1; c <= 10; c++) {
      const cell = row.getCell(c);
      cell.alignment = { vertical: 'middle', horizontal: c === 10 ? 'left' : (c === 9 ? 'right' : 'center') };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
      };
    }

    row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBEB' } };
    row.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F3FF' } };
    row.getCell(9).font = { bold: true, color: { argb: 'FF047857' } };
  });

  const totRow = sheet.getRow(13);
  totRow.height = 28;
  sheet.mergeCells('A13:D13');
  totRow.getCell(1).value = `TOTAL SEMANA (${rangeStr})`;
  totRow.getCell(5).value = { formula: 'SUM(E6:E12)', result: stats.totalBaseHours };
  totRow.getCell(5).numFmt = '0.00';
  totRow.getCell(7).value = { formula: 'SUM(G6:G12)', result: stats.totalExtraHours };
  totRow.getCell(7).numFmt = '0.00';
  totRow.getCell(8).value = { formula: 'SUM(H6:H12)', result: stats.totalHours };
  totRow.getCell(8).numFmt = '0.00 "hrs"';
  totRow.getCell(9).value = { formula: 'SUM(I6:I12)', result: stats.totalPay };
  totRow.getCell(9).numFmt = '$#,##0.00';

  for (let c = 1; c <= 10; c++) {
    const cell = totRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: c === 9 ? 'right' : 'center' };
  }
  totRow.getCell(9).font = { size: 12, bold: true, color: { argb: 'FF34D399' } };

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Horas_Dispatch_${week.sundayISO}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('📊 Excel descargado correctamente');
}

async function importFromExcel(file) {
  if (!file || typeof ExcelJS === 'undefined') return;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return;

    let sundayISO = String(sheet.getCell('B3').value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sundayISO)) {
      sundayISO = appState.currentWeekSunday;
    } else {
      sundayISO = getSundayISO(parseISODateLocal(sundayISO));
    }

    const rateBase = parseFloat(sheet.getCell('E3').value) || 10.0;
    const importedDays = [];

    for (let i = 0; i < 7; i++) {
      const rIdx = 6 + i;
      const row = sheet.getRow(rIdx);
      const startStr = String(row.getCell(3).value || '23:00').trim();
      const endStr = String(row.getCell(4).value || '08:00').trim();

      const rawBase = row.getCell(5).value;
      const bHours = typeof rawBase === 'object' && rawBase !== null ? Number(rawBase.result || 0) : Number(rawBase || 0);

      const rawExtra = row.getCell(7).value;
      const eHours = typeof rawExtra === 'object' && rawExtra !== null ? Number(rawExtra.result || 0) : Number(rawExtra || 0);

      const notes = String(row.getCell(10).value || '').trim();

      importedDays.push({
        dayIndex: i,
        dayName: DAY_NAMES[i],
        dateISO: addDaysISO(sundayISO, i),
        worked: bHours > 0,
        startTime: startStr.includes(':') ? startStr : '23:00',
        endTime: endStr.includes(':') ? endStr : '08:00',
        baseHours: Math.round(bHours * 100) / 100,
        extraShifts: eHours > 0 ? [{ startTime: '14:00', endTime: minutesToTime(14 * 60 + Math.round(eHours * 60)), hours: Math.round(eHours * 100) / 100 }] : [],
        notes
      });
    }

    appState.currentWeekSunday = sundayISO;
    appState.rateBase = rateBase;
    appState.weeks[sundayISO] = {
      sundayISO,
      rateBase,
      days: importedDays,
      updatedAt: new Date().toISOString()
    };

    saveState('📂 Excel cargado y sincronizado');
    renderAll();
  } catch (err) {
    console.error(err);
    alert('No se pudo leer el archivo Excel.');
  }
}

// ============================================================================
// CÓDIGO DE GOOGLE APPS SCRIPT PARA COPIAR CON 1 CLIC
// ============================================================================

const GOOGLE_APPS_SCRIPT_CODE = `const DB_SHEET_NAME = '_RespaldoWeb';
const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const state = readStateFromSpreadsheet(ss);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, spreadsheetUrl: ss.getUrl(), data: state }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const payload = JSON.parse(e.postData.contents);
    const appState = payload.state;
    if (!appState) throw new Error('Sin datos');

    saveBackupState(ss, appState);
    const currentSunday = appState.currentWeekSunday;
    if (currentSunday && appState.weeks && appState.weeks[currentSunday]) {
      renderWeekSheetInDrive(ss, appState.weeks[currentSunday]);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, savedAt: new Date().toISOString(), spreadsheetUrl: ss.getUrl() }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function renderWeekSheetInDrive(ss, week) {
  const sheetName = 'Semana ' + week.sundayISO;
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName, 0);
  sheet.clear();

  const widths = [115, 110, 100, 100, 115, 210, 115, 115, 125, 250];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  sheet.getRange('A1:J1').merge()
    .setValue('⚡ AMAZON DISPATCH — CONTROL DE HORAS (Semana Dom ' + week.sundayISO + ')')
    .setBackground('#111827').setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(12).setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);

  sheet.getRange('A3').setValue('Inicio (Dom):').setFontWeight('bold');
  sheet.getRange('B3').setValue(week.sundayISO).setHorizontalAlignment('center').setBackground('#F1F5F9');
  sheet.getRange('D3').setValue('Pago por Hora ($):').setFontWeight('bold');
  sheet.getRange('E3').setValue(Number(week.rateBase || 10)).setNumberFormat('$#,##0.00').setFontWeight('bold').setFontColor('#047857').setBackground('#D1FAE5').setHorizontalAlignment('center');

  const headers = [['Día', 'Fecha', 'Entrada', 'Salida', 'Horas Turno', 'Otros Horarios (Extras)', 'Horas Extras', 'Total Horas', 'Pago Día ($)', 'Notas']];
  sheet.getRange('A5:J5').setValues(headers).setBackground('#1E293B').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.setRowHeight(5, 26);

  const rows = [];
  for (let i = 0; i < 7; i++) {
    const day = week.days[i] || {};
    const bHours = day.worked ? (Number(day.baseHours) || 0) : 0;
    const extraShifts = Array.isArray(day.extraShifts) ? day.extraShifts : [];
    const eHours = extraShifts.reduce((acc, s) => acc + (Number(s.hours) || 0), 0);
    const extraDesc = extraShifts.map(ex => (ex.startTime || '') + '-' + (ex.endTime || '') + ' (' + ex.hours + 'h)').join(', ');
    rows.push([
      day.dayName || DAY_NAMES[i], day.dateISO || '',
      day.worked ? (day.startTime || '23:00') : '-', day.worked ? (day.endTime || '08:00') : '-',
      Math.round(bHours * 100) / 100, extraDesc || '-', Math.round(eHours * 100) / 100, '', '', day.notes || ''
    ]);
  }
  sheet.getRange('A6:J12').setValues(rows);

  for (let i = 0; i < 7; i++) {
    const r = 6 + i;
    sheet.setRowHeight(r, 24);
    sheet.getRange('H' + r).setFormula('=E' + r + '+G' + r);
    sheet.getRange('I' + r).setFormula('=H' + r + '*$E$3');
  }
  sheet.getRange('A6:I12').setHorizontalAlignment('center');
  sheet.getRange('I6:I12').setHorizontalAlignment('right').setNumberFormat('$#,##0.00').setFontWeight('bold').setFontColor('#047857');
  sheet.getRange('E6:E12').setNumberFormat('0.00').setBackground('#FFFBEB');
  sheet.getRange('G6:H12').setNumberFormat('0.00');
  sheet.getRange('G6:G12').setBackground('#F5F3FF');
  sheet.getRange('A6:J12').setBorder(true, true, true, true, true, true, '#E2E8F0', SpreadsheetApp.BorderStyle.SOLID);

  sheet.getRange('A13:D13').merge().setValue('TOTAL SEMANA (' + week.sundayISO + ')');
  sheet.getRange('E13').setFormula('=SUM(E6:E12)').setNumberFormat('0.00');
  sheet.getRange('G13').setFormula('=SUM(G6:G12)').setNumberFormat('0.00');
  sheet.getRange('H13').setFormula('=SUM(H6:H12)').setNumberFormat('0.00 "hrs"');
  sheet.getRange('I13').setFormula('=SUM(I6:I12)').setNumberFormat('$#,##0.00');
  sheet.getRange('A13:J13').setBackground('#111827').setFontColor('#FFFFFF').setFontWeight('bold').setVerticalAlignment('middle');
  sheet.getRange('A13:H13').setHorizontalAlignment('center');
  sheet.getRange('I13').setHorizontalAlignment('right').setFontColor('#34D399').setFontSize(11);
  sheet.setRowHeight(13, 28);
}

function saveBackupState(ss, appState) {
  let dbSheet = ss.getSheetByName(DB_SHEET_NAME);
  if (!dbSheet) { dbSheet = ss.insertSheet(DB_SHEET_NAME); dbSheet.hideSheet(); }
  dbSheet.getRange('A1').setValue(JSON.stringify(appState));
  dbSheet.getRange('A2').setValue(new Date().toISOString());
}

function readStateFromSpreadsheet(ss) {
  let state = { theme: 'dark', rateBase: 10, currentWeekSunday: '', weeks: {} };
  const dbSheet = ss.getSheetByName(DB_SHEET_NAME);
  if (dbSheet) {
    const raw = dbSheet.getRange('A1').getValue();
    if (raw) { try { state = JSON.parse(raw); } catch (e) {} }
  }
  ss.getSheets().forEach((sh) => {
    const name = sh.getName();
    if (name.indexOf('Semana ') === 0) {
      const sundayISO = String(sh.getRange('B3').getDisplayValue() || name.replace('Semana ', '')).trim();
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(sundayISO)) return;
      const rateBase = parseFloat(sh.getRange('E3').getValue()) || 10;
      const values = sh.getRange('A6:J12').getValues();
      const displayVals = sh.getRange('A6:J12').getDisplayValues();
      const existingWeek = (state.weeks && state.weeks[sundayISO]) ? state.weeks[sundayISO] : null;
      const days = [];
      for (let i = 0; i < 7; i++) {
        const row = values[i]; const dRow = displayVals[i];
        const bHours = parseFloat(row[4]) || 0; const eHours = parseFloat(row[6]) || 0;
        const startStr = dRow[2] && dRow[2] !== '-' ? String(dRow[2]).trim() : '23:00';
        const endStr = dRow[3] && dRow[3] !== '-' ? String(dRow[3]).trim() : '08:00';
        const notes = String(row[9] || '').trim();
        let extraShifts = [];
        if (existingWeek && existingWeek.days && existingWeek.days[i] && Array.isArray(existingWeek.days[i].extraShifts)) {
          const prevExtras = existingWeek.days[i].extraShifts;
          const prevSum = Math.round(prevExtras.reduce((a, s) => a + (Number(s.hours) || 0), 0) * 100) / 100;
          if (Math.abs(prevSum - eHours) < 0.01) extraShifts = prevExtras;
          else if (eHours > 0) extraShifts = [{ startTime: '14:00', endTime: '15:00', hours: Math.round(eHours * 100) / 100 }];
        } else if (eHours > 0) {
          extraShifts = [{ startTime: '14:00', endTime: '15:00', hours: Math.round(eHours * 100) / 100 }];
        }
        days.push({
          dayIndex: i, dayName: DAY_NAMES[i], dateISO: String(dRow[1] || '').trim(),
          worked: bHours > 0, startTime: startStr.indexOf(':') !== -1 ? startStr : '23:00',
          endTime: endStr.indexOf(':') !== -1 ? endStr : '08:00', baseHours: Math.round(bHours * 100) / 100,
          extraShifts: extraShifts, notes: notes
        });
      }
      if (!state.weeks) state.weeks = {};
      state.weeks[sundayISO] = { sundayISO, rateBase, days, updatedAt: new Date().toISOString() };
      if (!state.currentWeekSunday) state.currentWeekSunday = sundayISO;
    }
  });
  return state;
}`;

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toastNotification');
  document.getElementById('toastMessage').textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  renderAll();

  // Inicializar estado de Google Drive
  document.getElementById('driveWebhookInput').value = driveConfig.webhookUrl;
  updateDriveStatusUI(driveConfig.webhookUrl ? 'synced' : 'idle');

  // Sincronización automática al abrir la página:
  // - Si la web ya tiene datos cargados, los envía automáticamente a Google Drive para actualizar el archivo.
  // - Si la web está en blanco (ej. otro navegador o caché borrado), recupera de Google Drive y luego asegura que la tabla exista.
  if (driveConfig.webhookUrl) {
    if (!isLocalDataCompletelyEmpty()) {
      pushStateToGoogleDrive(false);
    } else {
      pullStateFromGoogleDrive(false).then(() => {
        pushStateToGoogleDrive(false);
      });
    }
  }

  document.getElementById('btnThemeToggle').addEventListener('click', () => {
    appState.theme = appState.theme === 'dark' ? 'light' : 'dark';
    saveState();
    applyTheme();
  });

  document.getElementById('btnPrevWeek').addEventListener('click', () => {
    appState.currentWeekSunday = addDaysISO(appState.currentWeekSunday, -7);
    ensureCurrentWeekExists();
    saveState();
    renderAll();
  });

  document.getElementById('btnNextWeek').addEventListener('click', () => {
    appState.currentWeekSunday = addDaysISO(appState.currentWeekSunday, 7);
    ensureCurrentWeekExists();
    saveState();
    renderAll();
  });

  document.getElementById('weekDatePicker').addEventListener('change', (e) => {
    if (!e.target.value) return;
    appState.currentWeekSunday = getSundayISO(parseISODateLocal(e.target.value));
    ensureCurrentWeekExists();
    saveState();
    renderAll();
  });

  document.getElementById('rateBaseInput').addEventListener('change', (e) => {
    const val = Math.max(0, parseFloat(e.target.value) || 0);
    appState.rateBase = val;
    const week = ensureCurrentWeekExists();
    week.rateBase = val;
    saveState('Tarifa actualizada');
    renderAll();
  });

  document.getElementById('btnClearWeek').addEventListener('click', () => {
    const key = appState.currentWeekSunday;
    appState.weeks[key] = createEmptyWeek(key);
    saveState('Semana vaciada (todo en 0)');
    renderAll();
  });

  document.getElementById('btnExportExcel').addEventListener('click', exportToExcel);
  document.getElementById('excelImportInput').addEventListener('change', (e) => {
    if (e.target.files[0]) {
      importFromExcel(e.target.files[0]);
      e.target.value = '';
    }
  });

  // Eventos del Modal de Google Drive
  const modal = document.getElementById('driveModalBackdrop');
  document.getElementById('btnOpenDriveModal').addEventListener('click', () => {
    document.getElementById('driveWebhookInput').value = driveConfig.webhookUrl;
    modal.style.display = 'flex';
  });

  document.getElementById('btnCloseDriveModal').addEventListener('click', () => {
    modal.style.display = 'none';
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  document.getElementById('btnSaveDriveUrl').addEventListener('click', async () => {
    const url = document.getElementById('driveWebhookInput').value.trim();
    driveConfig.webhookUrl = url;
    localStorage.setItem(DRIVE_URL_KEY, url);

    if (!url) {
      updateDriveStatusUI('idle');
      showToast('Desconectado de Google Drive');
      return;
    }

    // Si la página está vacía (0 horas), intentar primero traer datos existentes de Drive; si no, guardar los actuales
    if (isLocalDataCompletelyEmpty()) {
      await pullStateFromGoogleDrive(true);
      await pushStateToGoogleDrive(false);
    } else {
      await pushStateToGoogleDrive(true);
    }
  });

  document.getElementById('btnPushToDriveNow').addEventListener('click', () => {
    pushStateToGoogleDrive(true);
  });

  document.getElementById('btnPullFromDriveNow').addEventListener('click', () => {
    pullStateFromGoogleDrive(true);
  });

  document.getElementById('btnQuickPullDrive').addEventListener('click', () => {
    pullStateFromGoogleDrive(true);
  });

  document.getElementById('btnCopyAppsScript').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(GOOGLE_APPS_SCRIPT_CODE);
      showToast('📋 Código copiado. Pégalo en Extensiones → Apps Script');
    } catch (err) {
      alert('Puedes copiar el código desde el archivo google_drive_script.gs en tu carpeta.');
    }
  });
});
