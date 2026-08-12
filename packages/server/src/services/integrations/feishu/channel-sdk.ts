/** Local boundary around the official SDK so registration/channel behavior is injectable in tests. */
export {
  Client,
  createLarkChannel,
  type LarkChannel,
  LoggerLevel,
  registerApp,
} from "@larksuiteoapi/node-sdk";
