/* Executes extracted production provider functions under a controlled scheduler.
 * MMIO and FreeRTOS are mocked; target ABI and physical cleanup need real firmware. */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <setjmp.h>
#include "aily_packet_abi.h"
#define CANDIDATE 1
_Static_assert(sizeof(uint32_t)==4, "Retry latch is exactly32bits");
_Static_assert(__atomic_always_lock_free(4,0), "Host regression requires lock-free32bit atomics");
#define pdTRUE 1
#define pdFALSE 0
#define pdPASS 1
#define portMAX_DELAY UINT32_MAX
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_INVALID_ARG 2
#define ESP_ERR_NO_MEM 3
#define ESP_ERR_INVALID_STATE 4
#define ESP_ERR_NOT_FOUND 5
#define ESP_BT_CONTROLLER_CONFIG_MAGIC_VAL 0x5A17u
#define ESP_LOGE(tag,format,reason) mock_log(tag,format,reason)
typedef int esp_err_t;
typedef enum {ESP_BT_MODE_IDLE=0,ESP_BT_MODE_BLE=1,ESP_BT_MODE_BTDM=3} esp_bt_mode_t;
typedef enum {ESP_BT_CONTROLLER_STATUS_IDLE,ESP_BT_CONTROLLER_STATUS_INITED,ESP_BT_CONTROLLER_STATUS_ENABLED} esp_bt_controller_status_t;
typedef struct {uint32_t magic;esp_bt_mode_t mode;} esp_bt_controller_config_t;
typedef struct {bool held;bool binary;} MockSemaphore;
typedef int StaticSemaphore_t;
typedef MockSemaphore *SemaphoreHandle_t;
typedef void *TaskHandle_t;
typedef struct {void(*notify_host_send_available)(void);int(*notify_host_recv)(uint8_t*,uint16_t);} esp_vhci_host_callback_t;
#include "provider-globals.inc"
static MockSemaphore mutex_env,done_env={.binary=true},quiet_env={.binary=true};
static unsigned capacity, status_env,epoch_env,notify_count,delay_count,loop_limit;
static unsigned rx_ack_writes,tx_commit_writes,reset_writes,log_count,busy_check_count,unexpected_mutex_waits;
static bool last_busy_check_result;
static enum {NO_SCHEDULE,BUSY_AT_DELAY,STORE_IN_CALLBACK,DROP_CAPACITY_AT_DELAY} schedule;
static jmp_buf loop_exit;
bool __wrap_esp_vhci_host_check_send_available(void);
static void mock_log(const char *tag,const char *format,const char *reason){assert(tag&&format&&reason);++log_count;}
static uint32_t reg_read(unsigned offset){
 switch(offset){
 case AILY_PACKET_MAGIC_REG:return AILY_HCI_MAGIC;
 case AILY_PACKET_SCHEMA_REG:return AILY_PACKET_SCHEMA;
 case AILY_PACKET_MAX_REG:return AILY_HCI_MAX_PACKET;
 case AILY_PACKET_STATUS_REG:return status_env;
 case AILY_PACKET_EPOCH_REG:return epoch_env;
 case AILY_PACKET_TX_CAP_REG:return capacity;
 case AILY_PACKET_RX_LEN_REG:case AILY_PACKET_RX_REMAIN_REG:case AILY_PACKET_TX_LEN_REG:return 0;
 case AILY_PACKET_RX_DATA_REG:return UINT32_MAX;
 default:assert(!"Unexpected MMIO read");return 0;
 }
}
static void reg_write(unsigned offset,uint32_t value){
 if(offset==AILY_PACKET_CTRL_REG){
  if(value==AILY_PACKET_RESET){++reset_writes;++epoch_env;status_env=AILY_PACKET_CONNECTED;}
  else if(value==AILY_PACKET_ENABLE)status_env|=AILY_PACKET_ENABLED;
  else if(value==AILY_PACKET_CLOSE){status_env=AILY_PACKET_CONNECTED;++epoch_env;}
  else assert(!"Unexpected control");
 }else if(offset==AILY_PACKET_RX_ACK_REG){++rx_ack_writes;assert(!"Regression has no RX packets; ACK must never be fabricated");}
 else if(offset==AILY_PACKET_TX_COMMIT_REG){++tx_commit_writes;assert(!"Regression must not retry/send packets");}
 else assert(!"Unexpected MMIO write");
}
static SemaphoreHandle_t xSemaphoreCreateMutexStatic(StaticSemaphore_t *storage){assert(storage==&lock_storage);return &mutex_env;}
static SemaphoreHandle_t xSemaphoreCreateBinaryStatic(StaticSemaphore_t *storage){return storage==&done_storage?&done_env:&quiet_env;}
static int xSemaphoreTake(SemaphoreHandle_t sem,uint32_t ticks){
 assert(sem);
 if(sem->binary){if(sem->held){sem->held=false;return pdTRUE;}return pdFALSE;}
 if(sem->held){if(ticks!=0)++unexpected_mutex_waits;return pdFALSE;}
 sem->held=true;return pdTRUE;
}
static int xSemaphoreGive(SemaphoreHandle_t sem){assert(sem);if(sem->binary)sem->held=true;else{assert(sem->held);sem->held=false;}return pdTRUE;}
static void vTaskSuspend(void *arg){(void)arg;assert(!"Stopping branch is outside this scheduling regression");}
static int xTaskCreate(void(*body)(void*),const char *name,unsigned stack,void *arg,unsigned priority,TaskHandle_t *handle){assert(body&&name&&stack==4096&&arg==NULL&&priority==6);*handle=(void*)(uintptr_t)1;return pdPASS;}
static void simulate_sdk_check_while_another_task_holds_mutex(void){
 assert(!mutex_env.held);mutex_env.held=true;
 last_busy_check_result=__wrap_esp_vhci_host_check_send_available();
 ++busy_check_count;assert(last_busy_check_result==false);
 mutex_env.held=false;
}
static void notify_available(void){
 assert(!mutex_env.held); /* The original selected callback stays outside provider mutex. */
 ++notify_count;
 if(schedule==STORE_IN_CALLBACK&&notify_count==1)simulate_sdk_check_while_another_task_holds_mutex();
}
static void vTaskDelay(unsigned ticks){
 assert(ticks==1&&!mutex_env.held);++delay_count;
 if(delay_count==1&&(schedule==BUSY_AT_DELAY||schedule==DROP_CAPACITY_AT_DELAY)){
  simulate_sdk_check_while_another_task_holds_mutex();
  if(schedule==DROP_CAPACITY_AT_DELAY)capacity=AILY_HCI_MAX_PACKET-1;
 }
 if(delay_count>=loop_limit)longjmp(loop_exit,1);
}
#include "provider-functions.inc"
static void reset_fixture(bool enable_controller){
 mutex_env=(MockSemaphore){0};done_env=(MockSemaphore){.binary=true};quiet_env=(MockSemaphore){.binary=true};
 lock=done=quiet=NULL;receiver=NULL;state=ESP_BT_CONTROLLER_STATUS_IDLE;
 callbacks=(esp_vhci_host_callback_t){0};configured_mode=ESP_BT_MODE_IDLE;released_modes=0;
 failed=stopping=joining=send_notify_pending=quiescing=quiet_waiting=false;
 capacity=AILY_HCI_MAX_PACKET;status_env=AILY_PACKET_CONNECTED;epoch_env=7;
 notify_count=delay_count=rx_ack_writes=tx_commit_writes=reset_writes=log_count=busy_check_count=unexpected_mutex_waits=0;
 schedule=NO_SCHEDULE;loop_limit=2;
#if CANDIDATE
 __atomic_store_n(&send_check_retry,0u,__ATOMIC_RELEASE);
#endif
 esp_bt_controller_config_t cfg={.magic=ESP_BT_CONTROLLER_CONFIG_MAGIC_VAL,.mode=ESP_BT_MODE_BLE};
 assert(__wrap_esp_bt_controller_init(&cfg)==ESP_OK);assert(state==ESP_BT_CONTROLLER_STATUS_INITED&&reset_writes==1);
 if(enable_controller)assert(__wrap_esp_bt_controller_enable(ESP_BT_MODE_BLE)==ESP_OK);
 callbacks.notify_host_send_available=notify_available;
}
static void run_original_receiver(void){if(setjmp(loop_exit)==0)receive_loop(NULL);assert(delay_count==loop_limit);assert(!mutex_env.held&&unexpected_mutex_waits==0);assert(rx_ack_writes==0&&tx_commit_writes==0);}
static void result(const char *name){printf("{\"variant\":\"%s\",\"case\":\"%s\",\"passed\":true,\"notifications\":%u,\"busyChecks\":%u,\"rxAckWrites\":%u,\"txCommitWrites\":%u}\n",CANDIDATE?"candidate":"production",name,notify_count,busy_check_count,rx_ack_writes,tx_commit_writes);}
int main(void){
 reset_fixture(true);schedule=BUSY_AT_DELAY;run_original_receiver();
 assert(capacity==AILY_HCI_MAX_PACKET&&busy_check_count==1);
 assert(notify_count==(CANDIDATE?2u:1u));
 result(CANDIDATE?"busy-check-rearmed-on-unchanged-real-capacity":"lost-wakeup-reproduced-after-busy-check");
 reset_fixture(true);capacity=AILY_HCI_MAX_PACKET-1;
 assert(!__wrap_esp_vhci_host_check_send_available());
#if CANDIDATE
 assert(__atomic_load_n(&send_check_retry,__ATOMIC_ACQUIRE)==0u); /* Low capacity alone must not set retry. */
 __atomic_store_n(&send_check_retry,1u,__ATOMIC_RELEASE);
#endif
 run_original_receiver();assert(notify_count==0);
#if CANDIDATE
 assert(__atomic_load_n(&send_check_retry,__ATOMIC_ACQUIRE)==1u); /* No capacity: keep the request, don't consume/notify. */
#endif
 result("insufficient-real-capacity-never-notifies");
 reset_fixture(false);
#if CANDIDATE
 __atomic_store_n(&send_check_retry,1u,__ATOMIC_RELEASE);
#endif
 assert(!__wrap_esp_vhci_host_check_send_available());run_original_receiver();assert(notify_count==0);result("not-enabled-never-notifies");
#if CANDIDATE
 reset_fixture(true);__atomic_store_n(&send_check_retry,1u,__ATOMIC_RELEASE);schedule=STORE_IN_CALLBACK;run_original_receiver();
 assert(notify_count==2&&busy_check_count==1&&__atomic_load_n(&send_check_retry,__ATOMIC_ACQUIRE)==0u);
 result("store-after-exchange-survives-until-next-turn");
 reset_fixture(true);__atomic_store_n(&send_check_retry,1u,__ATOMIC_RELEASE);run_original_receiver();assert(notify_count==1);result("single-request-consumed-without-unbounded-notify");
 reset_fixture(true);simulate_sdk_check_while_another_task_holds_mutex();assert(__atomic_load_n(&send_check_retry,__ATOMIC_ACQUIRE)==1u);
 /* Environment admits a new init only after the previous fake task is retired.
  * This is a host scheduling test, not a physical Worker/deinit proof. */
 receiver=NULL;state=ESP_BT_CONTROLLER_STATUS_IDLE;
 esp_bt_controller_config_t cfg={.magic=ESP_BT_CONTROLLER_CONFIG_MAGIC_VAL,.mode=ESP_BT_MODE_BLE};
 assert(__wrap_esp_bt_controller_init(&cfg)==ESP_OK&&__atomic_load_n(&send_check_retry,__ATOMIC_ACQUIRE)==0u);result("actual-init-reset-section-clears-stale-retry");
 reset_fixture(true);schedule=DROP_CAPACITY_AT_DELAY;run_original_receiver();assert(notify_count==1);assert(__atomic_load_n(&send_check_retry,__ATOMIC_ACQUIRE)==1u);result("busy-request-does-not-override-later-capacity-loss");
#endif
 return 0;
}
