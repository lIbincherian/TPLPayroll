# TPL Payroll

A comprehensive payroll management system built with Next.js, designed to streamline employee management, attendance tracking, and payroll generation for organizational needs.

## Overview

TPL Payroll is a modern web application that enables organizations to:

- **Manage Employees**: Create, update, and maintain employee records with comprehensive personal and employment details
- **Track Attendance**: Upload and validate weekly attendance records with automatic error detection and correction
- **Generate Payroll**: Create payroll runs with multi-step verification, including attendance and adjustment reviews
- **Handle Adjustments**: Create and approve payroll adjustments (bonuses, deductions, etc.) with a review workflow
- **Bulk Import/Export**: Import employee data from Excel and export reports in standard formats

## Tech Stack

- **Framework**: [Next.js 16.2](https://nextjs.org/) (App Router)
- **Database**: PostgreSQL with [Prisma ORM](https://www.prisma.io/)
- **UI**: React 19 with [Tailwind CSS 4](https://tailwindcss.com/) and [shadcn/ui](https://ui.shadcn.com/)
- **Forms**: React Hook Form with Zod validation
- **Testing**: Vitest (unit tests) and Playwright (E2E tests)
- **Icons**: Phosphor Icons and Lucide React

## Project Structure

```
src/
├── app/              # Next.js App Router pages and layouts
├── components/       # Shared UI components (layout, dashboard)
├── features/         # Feature slices (each self-contained)
│   ├── employee-management/
│   ├── employee-import-export/
│   ├── attendance-upload/
│   ├── payroll-generation/
│   └── payroll-adjustments/
├── services/         # Shared business logic (database queries)
└── types/            # Shared TypeScript types

e2e/                 # End-to-end tests with Playwright
prisma/              # Database schema and migrations
```

## Prerequisites

- **Node.js**: v18 or higher
- **PostgreSQL**: v12 or higher (local or remote)
- **npm or yarn**: Package manager

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

For local development, the project comes with a `.env` file pre-configured to work with the local Prisma Dev database. You can create a `.env.local` override if needed:

```env
# Application URL (for development)
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

### 3. Start the Development Database

The project leverages Prisma 7's development database capabilities. Before running the app, start the local Prisma Postgres server on the configured port:

```bash
npx prisma dev -n freshport -P 65000
```

Wait for the server to start successfully. It is configured to listen on port `65000` as defined in the default `DIRECT_DATABASE_URL`.

### 4. Set Up the Database Schema

Apply the committed migrations (`prisma/migrations/`) to the local database:

```bash
npx prisma migrate deploy
```

*(Optional)* You can seed the database with basic test data using the E2E setup utility:

```bash
node e2e/utils/setup-db.js
```

### 5. Run the Development Server

Start the Next.js development server:

```bash
npm run dev
```

The application will be available at [http://localhost:3000](http://localhost:3000).

## Available Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build for production |
| `npm start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run test` | Run unit tests in watch mode |
| `npm run test:run` | Run unit tests once |
| `npm run test:e2e` | Run E2E tests (requires database setup) |
| `npm run test:e2e:ui` | Run E2E tests with UI browser |

## Features

### Employee Management
- Create, read, update, and deactivate employee records
- Track wage history and employment changes
- Store critical documents and identifiers (Aadhaar, bank account, etc.)

### Attendance Upload
- Upload weekly attendance data via Excel files
- Automatic validation and error detection
- Manual week selection for flexible scheduling
- Employee matching and error flagging

### Payroll Generation
- Multi-step payroll creation workflow with verification gates
- Attendance verification before payroll processing
- Integration with payroll adjustments
- Support for multiple payroll runs per period

### Payroll Adjustments
- Create adjustments (bonuses, deductions, corrections)
- Review and approval workflow
- Prevent duplicate adjustments
- Integration with payroll runs

### Bulk Import/Export
- Import employee data from Excel with batch processing
- Export employee records to Excel
- Validation and error reporting during import

## Developing Locally

### Running Tests

**Unit Tests:**
```bash
npm run test
```

**E2E Tests:**

There are two recommended workflows for running E2E tests, depending on your needs:

1. **For Fast Local Iterations (The "Dev" Workflow):**
   Use this when actively writing tests or tweaking UI components. Playwright will reuse your running dev server.
   ```bash
   # In terminal 1: Start your dev server
   npm run dev

   # In terminal 2: Run tests (Playwright will detect port 3000 and skip starting a new server)
   npm run test:e2e
   ```

2. **For Guaranteed Reliability (The "Prod/CI" Workflow):**
   Use this before committing code to ensure tests pass against the compiled production build without memory panics.
   ```bash
   # Ensure no dev server is running on port 3000
   npm run build
   npm run test:e2e
   ```

Ensure your PostgreSQL database is running (`npx prisma dev`) before running E2E tests. The test suite will automatically set up a test database and seed it.

### Hot Reload

The development server automatically reloads when you modify files. Edit any file in `src/` to see changes instantly in your browser.

### Database Management

The schema is managed with Prisma Migrate. To change it, edit `prisma/schema.prisma`, then create the migration against your local database and commit the generated `prisma/migrations/<timestamp>_<name>/` directory with the schema change:

```bash
npx prisma migrate dev --name <describe_the_change>
```

Against a local `prisma dev` database, `migrate dev` needs `SHADOW_DATABASE_URL` set to that instance's shadow database (see [docs/ci-and-migrations.md](docs/ci-and-migrations.md#changing-the-schema) for how to find it).

To reset your local database to the committed migrations (local only, this drops all data):

```bash
npx prisma migrate reset
```

Never run `prisma db push`, `migrate reset` or `migrate dev` against the Supabase Production or Staging databases. Vercel applies migrations on deploy via `prisma migrate deploy`. See [docs/ci-and-migrations.md](docs/ci-and-migrations.md) for details.

## Production Deployment

### Build for Production

```bash
npm run build
```

### Start Production Server

```bash
npm start
```

The application will be available on the configured port (default: 3000).

## Documentation

- [Domain Model & Architecture](./CONTEXT.md) - Core concepts and data model
- [Agent Workflows](./AGENTS.md) - Development guidelines and feature slice architecture
- [API Routes](./src/app/api/) - Server-side endpoints

## Contributing

When adding new features, follow the feature slice architecture:

1. Create a feature directory under `src/features/[feature-name]/`
2. Include components, services, actions, and types specific to the feature
3. Add unit tests alongside implementation
4. Update documentation as needed

## License

This project is private and proprietary.
