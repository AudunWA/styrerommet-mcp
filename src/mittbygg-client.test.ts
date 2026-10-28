import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRscStream,
  sanitizeRscData,
  getMittByggOverview,
  getMittByggMaintenancePlan,
  getMittByggCondition,
  getMittByggBuildingParts,
  getMittByggBuildingPartDetails,
  getMittByggTasks,
  getMittByggCompanyInfo,
  getMittByggConditionReport,
  analyzeMaintenanceFinancing,
  MITTBYGG_ACTION_IDS,
} from "./mittbygg-client.ts";

describe("Mitt Bygg Client", () => {
  describe("RSC Parser & Sanitizer", () => {
    it("parses lines of RSC stream and filters out framework markers", () => {
      const sample = [
        '1:"$Sreact.fragment"',
        '3:I[12345,["/chunk.js"],"default"]',
        ':HL["/style.css","style"]',
        "a:X",
        '5:{"id":1,"title":"Fasadeoppussing","status":"planned"}',
        '6:[{"name":"Tak","year":2026}]',
      ].join("\n");

      const entries = parseRscStream(sample);
      assert.equal(entries.size, 2);
      assert.deepEqual(entries.get("5"), {
        id: 1,
        title: "Fasadeoppussing",
        status: "planned",
      });
      assert.deepEqual(entries.get("6"), [{ name: "Tak", year: 2026 }]);
    });

    it("parses binary/text chunks with T<hex_length> byte markers correctly", () => {
      // "Taktekking og snøfangere" has Norwegian characters
      const textChunk = "Taktekking og snøfangere på taket.";
      const byteLen = Buffer.byteLength(textChunk, "utf-8");
      const hexLen = byteLen.toString(16);

      const sample = Buffer.concat([
        Buffer.from(`1:T${hexLen},${textChunk}`, "utf-8"),
        Buffer.from('2:{"id":42,"done":true}\n', "utf-8"),
      ]);

      const entries = parseRscStream(sample);
      assert.equal(entries.get("1"), textChunk);
      assert.deepEqual(entries.get("2"), { id: 42, done: true });
    });

    it("sanitizes RSC specific dates and undefined values", () => {
      const input = {
        name: "Test",
        created: "$D2026-09-24T12:00:00.000Z",
        emptyField: "$undefined",
        items: [
          { date: "$D2024-01-01T00:00:00.000Z", note: "done" },
          "$undefined",
        ],
      };

      const sanitized = sanitizeRscData(input) as any;
      assert.equal(sanitized.name, "Test");
      assert.equal(sanitized.created, "2026-09-24T12:00:00.000Z");
      assert.equal(sanitized.emptyField, undefined);
      assert.equal(sanitized.items[0].date, "2024-01-01T00:00:00.000Z");
      assert.equal(sanitized.items[1], undefined);
    });
  });

  describe("Mitt Bygg Live / Integration Queries (eksempel instance)", () => {
    it("fetches maintenance plan with measures and recommendations", async () => {
      const plan = await getMittByggMaintenancePlan("eksempel");
      assert.equal(plan.companyNumber, "eksempel");
      assert.ok(plan.webUrl.includes("/eksempel/vedlikeholdsplan"));
      assert.ok(Array.isArray(plan.measures));
      assert.ok(Array.isArray(plan.recommendations));
      assert.ok(Array.isArray(plan.buildings));
      assert.ok(plan.buildings.length > 0);
      assert.ok(plan.recommendations.length > 0);
    });

    it("fetches condition overview and urgent measures", async () => {
      const condition = await getMittByggCondition("eksempel");
      assert.equal(condition.companyNumber, "eksempel");
      assert.ok(condition.webUrl.includes("/eksempel/tilstand"));
      assert.ok(typeof condition.currentScore === "number");
      assert.ok(Array.isArray(condition.urgentMeasures));
    });

    it("fetches list of 15 building parts with status", async () => {
      const parts = await getMittByggBuildingParts("eksempel");
      assert.equal(parts.companyNumber, "eksempel");
      assert.ok(parts.totalBuildingParts >= 15);
      const facade = parts.buildingParts.find((p) => p.part === "facade");
      assert.ok(facade);
      assert.equal(facade.label, "Fasade");
      assert.ok(facade.webUrl.includes("bygningsdel/facade"));
    });

    it("fetches building part details for facade", async () => {
      const details = await getMittByggBuildingPartDetails(
        "facade",
        "eksempel",
      );
      assert.equal(details.partType, "facade");
      assert.ok(details.webUrl.includes("bygningsdel/facade"));
      assert.ok(Array.isArray(details.historyRecords));
    });

    it("fetches maintenance tasks", async () => {
      const tasks = await getMittByggTasks("eksempel");
      assert.equal(tasks.companyNumber, "eksempel");
      assert.ok(tasks.totalTasks > 0);
      assert.ok(Array.isArray(tasks.tasks));
      assert.ok(tasks.tasks.length > 0);
    });

    it("fetches company and property details", async () => {
      const info = await getMittByggCompanyInfo("eksempel");
      assert.equal(info.companyNumber, "eksempel");
      assert.ok(info.webUrl.includes("/eksempel/om-selskapet"));
      assert.ok(Array.isArray(info.buildings));
      assert.ok(info.buildings.length > 0);
    });

    it("fetches condition report from Anticimex", async () => {
      const report = await getMittByggConditionReport("eksempel");
      assert.equal(report.companyNumber, "eksempel");
      assert.ok(report.webUrl.includes("/eksempel/bygningsrapport"));
      assert.ok(report.aggregate);
      assert.ok(report.mainElementsCount > 0);
      assert.ok(Array.isArray(report.mainElements));
    });

    it("fetches combined overview", async () => {
      const overview = await getMittByggOverview("eksempel");
      assert.equal(overview.companyNumber, "eksempel");
      assert.ok(overview.webUrl.includes("/eksempel"));
      assert.ok(typeof overview.conditionScore === "number");
      assert.ok(overview.buildingsCount > 0);
    });

    it("analyzes multi-year maintenance financing timeline", async () => {
      const analysis = await analyzeMaintenanceFinancing({
        companyNumber: "eksempel",
        horizonYears: 5,
      });
      assert.equal(analysis.companyNumber, "eksempel");
      assert.equal(analysis.horizonYears, 5);
      assert.ok(Array.isArray(analysis.timeline));
      assert.equal(analysis.timeline.length, 6);
      assert.ok(analysis.maintenanceSummary);
      assert.ok(Array.isArray(analysis.insights));
      assert.ok(analysis.insights.length > 0);
    });

    it("verifies all expected Server Action IDs are registered", () => {
      assert.equal(typeof MITTBYGG_ACTION_IDS.createMeasure, "string");
      assert.equal(typeof MITTBYGG_ACTION_IDS.updateMeasure, "string");
      assert.equal(typeof MITTBYGG_ACTION_IDS.deleteMeasure, "string");
      assert.equal(
        typeof MITTBYGG_ACTION_IDS.createMeasureFromRecommendation,
        "string",
      );
      assert.equal(typeof MITTBYGG_ACTION_IDS.updateBuildingName, "string");
      assert.equal(
        typeof MITTBYGG_ACTION_IDS.markBuildingPartRelevant,
        "string",
      );
      assert.equal(
        typeof MITTBYGG_ACTION_IDS.markBuildingPartIrrelevant,
        "string",
      );
      assert.equal(
        typeof MITTBYGG_ACTION_IDS.updateTaskStatusAndComment,
        "string",
      );
      assert.equal(
        typeof MITTBYGG_ACTION_IDS.updateTaskCommentAndYear,
        "string",
      );
      assert.equal(typeof MITTBYGG_ACTION_IDS.createTask, "string");
      assert.equal(typeof MITTBYGG_ACTION_IDS.addHistoryUserEntry, "string");
      assert.equal(typeof MITTBYGG_ACTION_IDS.updateHistoryUserEntry, "string");
      assert.equal(typeof MITTBYGG_ACTION_IDS.deleteHistoryUserEntry, "string");
      assert.equal(typeof MITTBYGG_ACTION_IDS.deleteDocument, "string");
      assert.equal(typeof MITTBYGG_ACTION_IDS.updateDocument, "string");
      assert.equal(typeof MITTBYGG_ACTION_IDS.uploadDocumentFile, "string");
      assert.equal(typeof MITTBYGG_ACTION_IDS.analyzeDocument, "string");
      assert.equal(typeof MITTBYGG_ACTION_IDS.saveDocument, "string");
      assert.equal(typeof MITTBYGG_ACTION_IDS.discardDocumentUpload, "string");
    });
  });
});
