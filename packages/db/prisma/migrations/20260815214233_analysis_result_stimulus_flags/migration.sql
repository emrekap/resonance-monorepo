-- AlterTable
ALTER TABLE "analysis_results" ADD COLUMN     "stimulus_has_audio" BOOLEAN,
ADD COLUMN     "stimulus_has_speech" BOOLEAN,
ADD COLUMN     "stimulus_has_visual" BOOLEAN;
