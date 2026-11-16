-- CreateEnum
CREATE TYPE "TimezoneSource" AS ENUM ('DETECTED', 'EXPLICIT');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC',
ADD COLUMN     "timezoneSource" "TimezoneSource" NOT NULL DEFAULT 'DETECTED';
