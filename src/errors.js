// One error shape for every layer: a plain Error carrying the HTTP status to send.
// Messages reach clients verbatim, so keep them generic and free of mail data.
export const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
