import test from "node:test";
import assert from "node:assert/strict";
import { CreateWhatsAppMessageTemplateMediaCommand } from "@aws-sdk/client-socialmessaging";
import { uploadAccountWhatsAppTemplateDocument } from "../src/services/accountWhatsApp.service.js";

test("AWS PDF approval media uses the WABA and S3 source, then consumes the header handle rather than a delivery media ID", async () => {
  const buffer = Buffer.from("%PDF-fictional-sample");
  const sourceS3File = { bucketName: "sample-bucket", key: "private/sample.pdf" };
  let stored = 0, requests = 0;
  const dependencies = {
    store: async (bytes, filename) => {
      stored++;
      assert.equal(bytes, buffer, "the original PDF bytes reach private object storage");
      assert.equal(filename, "sample.pdf");
      return sourceS3File;
    },
    senderDetails: async () => ({ wabaId: "waba-example" }),
    context: async () => ({
      sdk: { CreateWhatsAppMessageTemplateMediaCommand },
      client: { send: async (command) => {
        requests++;
        assert.ok(command instanceof CreateWhatsAppMessageTemplateMediaCommand);
        assert.deepEqual(command.input, { id: "waba-example", sourceS3File });
        return { metaHeaderHandle: "approval-header-handle", mediaId: "not-an-approval-handle" };
      } },
    }),
  };
  assert.equal(await uploadAccountWhatsAppTemplateDocument(buffer, "sample.pdf", dependencies), "approval-header-handle");
  assert.equal(stored, 1);
  assert.equal(requests, 1);
  await assert.rejects(uploadAccountWhatsAppTemplateDocument(buffer, "sample.pdf", {
    ...dependencies,
    context: async () => ({ sdk: { CreateWhatsAppMessageTemplateMediaCommand }, client: { send: async () => ({ mediaId: "delivery-only" }) } }),
  }), /sample receipt header handle/);
});
