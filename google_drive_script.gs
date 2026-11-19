// ============================================================================
// SCRIPT DE CONEXIÓN AUTOMÁTICA: AMAZON DISPATCH WEB <-> GOOGLE DRIVE
// ============================================================================
// INSTRUCCIONES:
// 1. Abre una Hoja de Cálculo de Google en tu Google Drive (https://sheets.new)
// 2. Ve al menú superior: Extensiones -> Apps Script
// 3. Borra el código que aparece y pega TODO este código.
// 4. Arriba a la derecha haz clic en "Implementar" -> "Nueva implementación"
// 5. En "Selecciona el tipo" (icono de engranaje), elige "Aplicación web"
// 6. En "Quién tiene acceso", selecciona: "Cualquier persona" (Anyone)
// 7. Haz clic en "Implementar", autoriza el acceso a tu cuenta y copia la URL.
// 8. Pega esa URL en el botón "☁️ Google Drive" de tu página web.
// ============================================================================

const DB_SHEET_NAME = '_RespaldoWeb';
const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// GET: Cuando la página web quiere IMPORTAR / RECUPERAR los datos desde Google Drive
function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const state = readStateFromSpreadsheet(ss);

    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        spreadsheetUrl: ss.getUrl(),
        spreadsheetName: ss.getName(),
        data: state
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// POST: Cuando haces un cambio en la página web y se GUARDA automáticamente en Google Drive
function doPost(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const payload = JSON.parse(e.postData.contents);

    if (payload.action === 'sync_from_drive') {
      const state = readStateFromSpreadsheet(ss);
      return ContentService
        .createTextOutput(JSON.stringify({
          ok: true,
          spreadsheetUrl: ss.getUrl(),
          data: state
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const appState = payload.state;
    if (!appState) {
      throw new Error('No se recibieron datos de la página web.');
    }

    // 1. Guardar respaldo completo en la hoja oculta _RespaldoWeb
    saveBackupState(ss, appState);

    // 2. Actualizar la hoja visual estilo Excel de la semana activa en Google Drive
    const currentSunday = appState.currentWeekSunday;
    if (currentSunday && appState.weeks && appState.weeks[currentSunday]) {
      renderWeekSheetInDrive(ss, appState.weeks[currentSunday]);
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        savedAt: new Date().toISOString(),
        spreadsheetUrl: ss.getUrl()
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Dibuja y actualiza la tabla visual de la semana en Google Sheets (con fórmulas y colores)
function renderWeekSheetInDrive(ss, week) {
  const sheetName = 'Semana ' + week.sundayISO;
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName, 0);
  }

  sheet.clear();

  // Anchos de columna
  const widths = [115, 110, 100, 100, 115, 210, 115, 115, 125, 250];
  widths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  // Título Superior
  sheet.getRange('A1:J1').merge()
    .setValue('⚡ AMAZON DISPATCH — CONTROL DE HORAS (Semana desde Dom ' + week.sundayISO + ')')
    .setBackground('#111827')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(12)
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);

  // Parámetros (Fila 3)
  sheet.getRange('A3').setValue('Inicio (Dom):').setFontWeight('bold');
  sheet.getRange('B3').setValue(week.sundayISO).setHorizontalAlignment('center').setBackground('#F1F5F9');
  sheet.getRange('D3').setValue('Pago por Hora ($):').setFontWeight('bold');
  sheet.getRange('E3').setValue(Number(week.rateBase || 10))
    .setNumberFormat('$#,##0.00')
    .setFontWeight('bold')
    .setFontColor('#047857')
    .setBackground('#D1FAE5')
    .setHorizontalAlignment('center');

  // Encabezados (Fila 5)
  const headers = [[
    'Día', 'Fecha', 'Entrada', 'Salida', 'Horas Turno',
    'Otros Horarios (Extras)', 'Horas Extras', 'Total Horas', 'Pago Día ($)', 'Notas'
  ]];
  sheet.getRange('A5:J5').setValues(headers)
    .setBackground('#1E293B')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(5, 26);

  // Filas 6 a 12 (Domingo a Sábado)
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const day = week.days[i] || {};
    const bHours = day.worked ? (Number(day.baseHours) || 0) : 0;
    const extraShifts = Array.isArray(day.extraShifts) ? day.extraShifts : [];
    const eHours = extraShifts.reduce((acc, s) => acc + (Number(s.hours) || 0), 0);
    const extraDesc = extraShifts.map(ex => (ex.startTime || '') + '-' + (ex.endTime || '') + ' (' + ex.hours + 'h)').join(', ');

    rows.push([
      day.dayName || DAY_NAMES[i],
      day.dateISO || '',
      day.worked ? (day.startTime || '23:00') : '-',
      day.worked ? (day.endTime || '08:00') : '-',
      Math.round(bHours * 100) / 100,
      extraDesc || '-',
      Math.round(eHours * 100) / 100,
      '', // Fórmula H
      '', // Fórmula I
      day.notes || ''
    ]);
  }

  sheet.getRange('A6:J12').setValues(rows);

  // Aplicar fórmulas y formatos a las filas 6 a 12
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

  // Fila 13: Totales de la Semana
  sheet.getRange('A13:D13').merge().setValue('TOTAL SEMANA (' + week.sundayISO + ')');
  sheet.getRange('E13').setFormula('=SUM(E6:E12)').setNumberFormat('0.00');
  sheet.getRange('G13').setFormula('=SUM(G6:G12)').setNumberFormat('0.00');
  sheet.getRange('H13').setFormula('=SUM(H6:H12)').setNumberFormat('0.00 "hrs"');
  sheet.getRange('I13').setFormula('=SUM(I6:I12)').setNumberFormat('$#,##0.00');

  sheet.getRange('A13:J13')
    .setBackground('#111827')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setVerticalAlignment('middle');
  sheet.getRange('A13:H13').setHorizontalAlignment('center');
  sheet.getRange('I13').setHorizontalAlignment('right').setFontColor('#34D399').setFontSize(11);
  sheet.setRowHeight(13, 28);
}

// Guarda el JSON completo en _RespaldoWeb
function saveBackupState(ss, appState) {
  let dbSheet = ss.getSheetByName(DB_SHEET_NAME);
  if (!dbSheet) {
    dbSheet = ss.insertSheet(DB_SHEET_NAME);
    dbSheet.hideSheet();
  }
  dbSheet.getRange('A1').setValue(JSON.stringify(appState));
  dbSheet.getRange('A2').setValue(new Date().toISOString());
}

// Lee el estado desde Google Sheets (incluyendo cualquier edición manual hecha en las celdas de las hojas)
function readStateFromSpreadsheet(ss) {
  let state = {
    theme: 'dark',
    rateBase: 10,
    currentWeekSunday: '',
    weeks: {}
  };

  const dbSheet = ss.getSheetByName(DB_SHEET_NAME);
  if (dbSheet) {
    const raw = dbSheet.getRange('A1').getValue();
    if (raw) {
      try {
        state = JSON.parse(raw);
      } catch (e) {}
    }
  }

  // También revisar todas las pestañas "Semana YYYY-MM-DD" por si el usuario editó celdas directamente en Google Drive
  const sheets = ss.getSheets();
  sheets.forEach((sh) => {
    const name = sh.getName();
    if (name.indexOf('Semana ') === 0) {
      const sundayISO = String(sh.getRange('B3').getDisplayValue() || name.replace('Semana ', '')).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sundayISO)) return;

      const rateBase = parseFloat(sh.getRange('E3').getValue()) || 10;
      const values = sh.getRange('A6:J12').getValues();
      const displayVals = sh.getRange('A6:J12').getDisplayValues();
      const existingWeek = (state.weeks && state.weeks[sundayISO]) ? state.weeks[sundayISO] : null;

      const days = [];
      for (let i = 0; i < 7; i++) {
        const row = values[i];
        const dRow = displayVals[i];
        const bHours = parseFloat(row[4]) || 0;
        const eHours = parseFloat(row[6]) || 0;
        const startStr = dRow[2] && dRow[2] !== '-' ? String(dRow[2]).trim() : '23:00';
        const endStr = dRow[3] && dRow[3] !== '-' ? String(dRow[3]).trim() : '08:00';
        const notes = String(row[9] || '').trim();

        // Conservar desglose de extraShifts si el total de horas extras coincide, o actualizarlo si se editó en Drive
        let extraShifts = [];
        if (existingWeek && existingWeek.days && existingWeek.days[i] && Array.isArray(existingWeek.days[i].extraShifts)) {
          const prevExtras = existingWeek.days[i].extraShifts;
          const prevSum = Math.round(prevExtras.reduce((a, s) => a + (Number(s.hours) || 0), 0) * 100) / 100;
          if (Math.abs(prevSum - eHours) < 0.01) {
            extraShifts = prevExtras;
          } else if (eHours > 0) {
            extraShifts = [{ startTime: '14:00', endTime: '15:00', hours: Math.round(eHours * 100) / 100 }];
          }
        } else if (eHours > 0) {
          extraShifts = [{ startTime: '14:00', endTime: '15:00', hours: Math.round(eHours * 100) / 100 }];
        }

        days.push({
          dayIndex: i,
          dayName: DAY_NAMES[i],
          dateISO: String(dRow[1] || '').trim(),
          worked: bHours > 0,
          startTime: startStr.indexOf(':') !== -1 ? startStr : '23:00',
          endTime: endStr.indexOf(':') !== -1 ? endStr : '08:00',
          baseHours: Math.round(bHours * 100) / 100,
          extraShifts: extraShifts,
          notes: notes
        });
      }

      if (!state.weeks) state.weeks = {};
      state.weeks[sundayISO] = {
        sundayISO: sundayISO,
        rateBase: rateBase,
        days: days,
        updatedAt: new Date().toISOString()
      };
      if (!state.currentWeekSunday) {
        state.currentWeekSunday = sundayISO;
      }
    }
  });

  return state;
}
