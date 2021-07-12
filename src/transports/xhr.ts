import { Event, Response, Status } from "@sentry/types";

import { sdk } from "../crossPlatform";

import { BaseTransport } from "./base";

/** `XHR` based transport */
export class XHRTransport extends BaseTransport {
  /**
   * @inheritDoc
   */
  public sendEvent(event: Event): PromiseLike<Response> {
    const request = sdk.request || sdk.httpRequest;

    // @ts-ignore
    return this._buffer.add(new Promise<Response>((resolve, reject) => {
      // tslint:disable-next-line: no-unsafe-any
      request({
        url: this.url,
        method: "POST",
        data: JSON.stringify(event),
        header: {
          "content-type": "application/json"
        },
        success(res: { statusCode: number }): void {
          resolve({
            status: Status.fromHttpCode(res.statusCode)
          });
        },
        fail(error: object): void {
          reject(error);
        }
      });
    }));
  }
}
