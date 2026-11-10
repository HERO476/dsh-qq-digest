/**
 * 工具处理器：工具面的唯一实现。
 *
 * 注意 run_summary 的实现：它**直接传死 trigger: 'manual'**，
 * 不接受调用方给的任何参数 —— 否则「手动触发」会多出一个可被注入影响的维度。
 * 传入的多余参数在这里被忽略，在漏斗里还会被 schema 与 extraKeys 双重拒绝。
 */

export function createToolHandlers(service) {
  return {
    async qq_digest_list_rooms() {
      return service.listRooms();
    },

    async qq_digest_run_summary() {
      return service.runSummary({ trigger: 'manual' });
    },

    async qq_digest_get_digest(args = {}) {
      const handle = args?.roomHandle;
      return service.getDigest(handle);
    },

    async qq_digest_status() {
      return service.status();
    },
  };
}
