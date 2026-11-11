/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS Node script run directly with `node` (package.json is not "type": "module"), so require() is how it imports. */
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

function makeBlock(name, site, regularHours, otHours) {
  const rows = [['Employee Name', name]];
  if (site) rows.push(['Site', site]);
  rows.push(['Regular', ...regularHours]);
  rows.push(['OT', ...otHours]);
  // No explicit separator row needed, as the parser detects 'Employee Name'
  return rows;
}

function generateAttendanceFile() {
  const wb = XLSX.utils.book_new();
  
  // Sheet 1: 3 blocks (the limit)
  const blocks1 = [
    ...makeBlock('Matched Employee', 'North', [8, 8, 8, 8, 8, 0, 0], [2, 0, 0, 0, 0, 0, 0]),
    ...makeBlock('Inactive Employee', 'South', [8, 8, 8, 8, 8, 0, 0], [0, 0, 0, 0, 0, 0, 0]),
    ...makeBlock('Resigned Employee', 'North', [8, 8, 8, 8, 8, 0, 0], [0, 0, 0, 0, 0, 0, 0]),
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(blocks1);
  XLSX.utils.sheet_add_aoa(ws1, [['Payroll Week:', '06 Mar 2025 - 12 Mar 2025']], { origin: 'A20' });
  XLSX.utils.book_append_sheet(wb, ws1, 'Sheet1');

  // Sheet 2: 1 block (the unmatched one)
  const blocks2 = [
    ...makeBlock('Unknown Person', 'East', [8, 8, 8, 8, 8, 0, 0], [0, 0, 0, 0, 0, 0, 0]),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(blocks2);
  XLSX.utils.book_append_sheet(wb, ws2, 'Sheet2');

  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
  }

  const filePath = path.join(fixturesDir, 'attendance-test.xlsx');
  XLSX.writeFile(wb, filePath);
  console.log(`Generated ${filePath}`);
}

generateAttendanceFile();
