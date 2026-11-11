/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS Node script run directly with `node` (package.json is not "type": "module"), so require() is how it imports. */
const XLSX = require('xlsx');
const path = require('path');

function createAttendanceSheet(data) {
  const aoa = Array(20).fill(null).map(() => Array(50).fill(null));
  
  // SECTION_BASES = [0, 15, 30]
  // Row 3 (Name), Row 4 (User ID), Row 12-18 (Time card)
  // col base + 9
  
  data.forEach((emp, sectionIndex) => {
    const base = sectionIndex * 15;
    
    // Name
    aoa[3][base + 9] = emp.name;
    // User ID
    aoa[4][base + 9] = emp.userId;
    
    // Time card (12-18)
    for (let i = 0; i < 7; i++) {
      const rowIdx = 12 + i;
      // bnIn (+1), bnOut (+3), anIn (+6), anOut (+8), otIn (+10), otOut (+12)
      // We'll use 8:00 - 12:00 and 13:00 - 17:00
      aoa[rowIdx][base + 1] = 8/24;
      aoa[rowIdx][base + 3] = 12/24;
      aoa[rowIdx][base + 6] = 13/24;
      aoa[rowIdx][base + 8] = 17/24;
      
      if (emp.overtime) {
        aoa[rowIdx][base + 10] = 17/24;
        aoa[rowIdx][base + 12] = 19/24; // 2 hours OT
      }
    }
  });

  // Payroll Week Detection (Optional but good)
  // The detector might look for dates. Let's add some dates in Row 0
  aoa[0][0] = 'Payroll Week: 06 Mar 2025 - 12 Mar 2025';

  return XLSX.utils.aoa_to_sheet(aoa);
}

function generateFixture() {
  const wb = XLSX.utils.book_new();

  // Sheet 1: 3 employees (Matched, Inactive, Resigned)
  const sheet1Data = [
    { name: 'Matched Employee', userId: 1, overtime: false },
    { name: 'Inactive Employee', userId: 2, overtime: false },
    { name: 'Resigned Employee', userId: 3, overtime: false },
  ];
  XLSX.utils.book_append_sheet(wb, createAttendanceSheet(sheet1Data), 'Sheet1');

  // Sheet 2: 1 employee (Unmatched)
  const sheet2Data = [
    { name: 'Unknown Person', userId: 999, overtime: false },
  ];
  XLSX.utils.book_append_sheet(wb, createAttendanceSheet(sheet2Data), 'Sheet2');

  const outputPath = path.join(__dirname, 'attendance-test.xlsx');
  XLSX.writeFile(wb, outputPath);
  console.log(`Fixture generated at ${outputPath}`);
}

generateFixture();
