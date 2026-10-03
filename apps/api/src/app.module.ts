import { DynamicModule, Module } from "@nestjs/common";
import { DB_TOKEN } from "./db/token";
import type { Db } from "./db/client";
import { AuthService } from "./auth/auth.service";
import { AuthController } from "./auth/auth.controller";
import { DirectoryController } from "./directory/directory.controller";
import { AcademicsController } from "./academics/academics.controller";
import { AttendanceController } from "./attendance/attendance.controller";
import { GradebookController } from "./gradebook/gradebook.controller";
import { StudentController } from "./student/student.controller";
import { MessagingController } from "./messaging/messaging.controller";
import { NotifyController } from "./notify/notify.controller";
import { ReportsController } from "./reports/reports.controller";
import { SsoController } from "./auth/sso.controller";
import { FeesController } from "./fees/fees.controller";
import { ExamsController } from "./exams/exams.controller";
import { TransportController } from "./transport/transport.controller";
import { HealthController } from "./health/health.controller";
import { SchoolController } from "./school/school.controller";
import { ImportController } from "./import/import.controller";
import { AuditController } from "./audit/audit.controller";
import { MfaAdminController } from "./auth/mfa-admin.controller";

@Module({})
export class AppModule {
  static register(db: Db): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        AuthController, DirectoryController, AcademicsController,
        AttendanceController, GradebookController, StudentController,
        MessagingController, NotifyController, ReportsController, SsoController,
        FeesController, ExamsController, TransportController, HealthController,
        SchoolController, ImportController, AuditController, MfaAdminController,
      ],
      providers: [AuthService, { provide: DB_TOKEN, useValue: db }],
    };
  }
}
