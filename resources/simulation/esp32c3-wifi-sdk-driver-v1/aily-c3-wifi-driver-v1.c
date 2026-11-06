/* ESP32-C3/C6 Wi-Fi simulation provider, AWF1 control-v1.
 * Explicit SDK driver/controller seam; not RF/802.11/WPA/MMIO fidelity.
 * Original Arduino WiFi/Network/HTTPClient and ESP-IDF esp_netif/lwIP remain.
 * JOIN_REPLY only associates; IP/DNS/TCP/HTTP are never returned by this shim.
 * SPDX-License-Identifier: MIT
 */
#include <stdlib.h>
#include <string.h>
#include "sdkconfig.h"
#include "esp_wifi.h"
#include "esp_wifi_default.h"
#include "esp_netif.h"
#include "esp_netif_defaults.h"
#include "esp_event.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "aily_packet_abi.h"
#include "awf-control-v1.h"
#if CONFIG_IDF_TARGET_ESP32C3
#define AILY_NETWORK_MMIO_BASE AILY_NETWORK_C3_BASE
#define AILY_WIFI_TARGET_OCTET 0xc3
#define AILY_WIFI_TASK_NAME "aily-c3-net"
#define AILY_WIFI_PROVIDER_NAME "aily.esp32c3-wifi-sdk-driver-v1/AWF1-open-sta"
#define AILY_WIFI_PROVIDER_FUNCTION aily_c3_wifi_provider
#elif CONFIG_IDF_TARGET_ESP32C6
#define AILY_NETWORK_MMIO_BASE UINT32_C(0x600f1000)
#define AILY_WIFI_TARGET_OCTET 0xc6
#define AILY_WIFI_TASK_NAME "aily-c6-net"
#define AILY_WIFI_PROVIDER_NAME "aily.esp32c6-wifi-sdk-driver-v1/AWF1-open-sta"
#define AILY_WIFI_PROVIDER_FUNCTION aily_c6_wifi_provider
#else
#error This simulation provider requires the selected ESP32-C3 or ESP32-C6 SDK.
#endif
#define REG(offset) (*(volatile uint32_t *)(AILY_NETWORK_MMIO_BASE+(offset)))
#define MAX_FRAME AILY_NETWORK_MAX_PACKET
#define CTRL_DEADLINE pdMS_TO_TICKS(10000)
static bool initialized, started, associated, pending_valid, transport_fenced;
static wifi_mode_t mode=WIFI_MODE_NULL;
static wifi_config_t configuration;
static wifi_ps_type_t power_save;
static esp_netif_t *sta;
/* esp_netif_config_sanity_check requires a non-NULL opaque io-driver handle.
 * This context is owned for the full Guest lifetime; no SDK private layout is
 * fabricated and no temporary stack pointer escapes esp_netif_new. */
static struct { uint32_t identity; } driver_context = { UINT32_C(0x41574946) };
static TaskHandle_t volatile task;
static SemaphoreHandle_t lock;
static uint32_t epoch,transaction;
static TickType_t pending_started;
static struct awf_pending pending;
static struct awf_reply ap;
static esp_event_handler_instance_t handlers[4];
static unsigned handler_count;
static const uint8_t sta_mac[6]={0x02,0xa1,AILY_WIFI_TARGET_OCTET,0x00,0x00,0x01};
const char *AILY_WIFI_PROVIDER_FUNCTION(void){return AILY_WIFI_PROVIDER_NAME;}
static bool present(void){return REG(AILY_PACKET_MAGIC_REG)==AILY_NETWORK_MAGIC&&REG(AILY_PACKET_SCHEMA_REG)==AILY_PACKET_SCHEMA&&(REG(AILY_PACKET_STATUS_REG)&AILY_PACKET_CONNECTED)&&!(REG(AILY_PACKET_STATUS_REG)&AILY_PACKET_FAULT);}
static bool active(void){return initialized&&!transport_fenced&&present()&&REG(AILY_PACKET_EPOCH_REG)==epoch;}
static bool take(void){return lock&&xSemaphoreTake(lock,pdMS_TO_TICKS(100))==pdTRUE;}
static void free_rx(void *handle,void *buffer){(void)handle;free(buffer);}
/* Caller owns lock. A successful commit means packet queued only, not delivery. */
static esp_err_t send_frame(const uint8_t *bytes,size_t length){
 if(!active())return ESP_ERR_INVALID_STATE;
 if(!bytes||length<14||length>MAX_FRAME)return ESP_ERR_INVALID_SIZE;
 if(REG(AILY_PACKET_TX_CAP_REG)<length)return ESP_ERR_NO_MEM;
 for(size_t i=0;i<length;i++)REG(AILY_PACKET_TX_DATA_REG)=bytes[i];
 if(REG(AILY_PACKET_TX_LEN_REG)!=length)return ESP_FAIL;
 REG(AILY_PACKET_TX_COMMIT_REG)=length;
 return (REG(AILY_PACKET_STATUS_REG)&AILY_PACKET_FAULT)?ESP_FAIL:ESP_OK;
}
static esp_err_t transmit(void *handle,void *buffer,size_t length){
 (void)handle;if(!take())return ESP_ERR_TIMEOUT;
 esp_err_t error=associated?send_frame(buffer,length):ESP_ERR_INVALID_STATE;
 xSemaphoreGive(lock);return error;
}
/* Installed Wi-Fi wlanif low_level_output calls esp_netif_transmit_wrap,
 * not the generic 3-argument transmit hook. Native copies the full frame before
 * returning; SDK retains and releases its own pbuf/netstack_buffer. */
static esp_err_t transmit_wrap(void *handle,void *buffer,size_t length,void *netstack_buffer){
 (void)netstack_buffer;return transmit(handle,buffer,length);
}
static void disconnected(uint8_t reason){
 wifi_event_sta_disconnected_t event={0};size_t len=strnlen((char*)configuration.sta.ssid,32);
 memcpy(event.ssid,configuration.sta.ssid,len);event.ssid_len=len;memcpy(event.bssid,ap.bssid,6);event.reason=reason;
 (void)esp_event_post(WIFI_EVENT,WIFI_EVENT_STA_DISCONNECTED,&event,sizeof event,pdMS_TO_TICKS(100));
}
static void connected(void){
 wifi_event_sta_connected_t event={0};size_t len=strnlen((char*)configuration.sta.ssid,32);
 memcpy(event.ssid,configuration.sta.ssid,len);event.ssid_len=len;memcpy(event.bssid,ap.bssid,6);event.channel=ap.channel;event.authmode=WIFI_AUTH_OPEN;event.aid=1;
 (void)esp_event_post(WIFI_EVENT,WIFI_EVENT_STA_CONNECTED,&event,sizeof event,pdMS_TO_TICKS(100));
}
static void pump(void *unused){
 (void)unused;
 for(;;){
  bool notify_lost=false;
  if(take()){
   if(!initialized){task=NULL;xSemaphoreGive(lock);vTaskDelete(NULL);}
   if(!transport_fenced&&(!active()||(pending_valid&&(TickType_t)(xTaskGetTickCount()-pending_started)>=CTRL_DEADLINE))){
    notify_lost=associated||pending_valid;associated=pending_valid=false;transport_fenced=true;
    /* A timeout/epoch change is not an AP close ACK; fence actual transport. */
    if(present())REG(AILY_PACKET_CTRL_REG)=AILY_PACKET_CLOSE;
   }
   xSemaphoreGive(lock);
  }
  if(notify_lost)disconnected(WIFI_REASON_BEACON_TIMEOUT);
  for(unsigned batch=0;batch<8;batch++){
   uint8_t *frame=NULL;size_t length=0;bool control=false,notify_connected=false,notify_disconnected=false;uint8_t reason=WIFI_REASON_UNSPECIFIED;
   if(!take())break;
   if(!started||!active()||!(REG(AILY_PACKET_STATUS_REG)&AILY_PACKET_RX_READY)){xSemaphoreGive(lock);break;}
   length=REG(AILY_PACKET_RX_LEN_REG);
   if(length<14||length>MAX_FRAME){REG(AILY_PACKET_CTRL_REG)=AILY_PACKET_CLOSE;associated=pending_valid=false;xSemaphoreGive(lock);disconnected(WIFI_REASON_BEACON_TIMEOUT);break;}
   frame=malloc(length);if(!frame){xSemaphoreGive(lock);break;}
   for(size_t i=0;i<length;i++)frame[i]=(uint8_t)REG(AILY_PACKET_RX_DATA_REG);
   if(REG(AILY_PACKET_RX_REMAIN_REG)!=0){free(frame);REG(AILY_PACKET_CTRL_REG)=AILY_PACKET_CLOSE;associated=pending_valid=false;xSemaphoreGive(lock);disconnected(WIFI_REASON_BEACON_TIMEOUT);break;}
   REG(AILY_PACKET_RX_ACK_REG)=length;
   control=frame[12]==0x88&&frame[13]==0xb5;
   if(control){
    struct awf_reply reply;
    if(pending_valid&&pending.epoch==epoch&&awf_parse_reply(frame,length,&pending,&reply)){
     uint8_t type=pending.type;pending_valid=false;
     if(type==AWF_JOIN_REQ&&reply.result==0){ap=reply;associated=true;notify_connected=true;}
     else if(type==AWF_LEAVE_REQ&&(reply.result==0||reply.result==4)){associated=false;notify_disconnected=true;reason=WIFI_REASON_ASSOC_LEAVE;}
     else{associated=false;notify_disconnected=true;reason=reply.result==1?WIFI_REASON_NO_AP_FOUND:WIFI_REASON_UNSPECIFIED;}
    }
   }
   bool admit_data=!control&&associated;
   if(admit_data&&sta){if(esp_netif_receive(sta,frame,length,frame)!=ESP_OK)free(frame);}else free(frame);
   xSemaphoreGive(lock);
   if(notify_connected)connected();if(notify_disconnected)disconnected(reason);
  }
  vTaskDelay(1);
 }
}
esp_err_t __wrap_esp_wifi_init(const wifi_init_config_t *config){
 if(!config||config->magic!=WIFI_INIT_CONFIG_MAGIC)return ESP_ERR_INVALID_ARG;
 if(initialized)return ESP_ERR_INVALID_STATE;if(!present())return ESP_ERR_NOT_FOUND;
 lock=xSemaphoreCreateMutex();if(!lock)return ESP_ERR_NO_MEM;
 REG(AILY_PACKET_CTRL_REG)=AILY_PACKET_RESET;epoch=REG(AILY_PACKET_EPOCH_REG);if(!epoch){vSemaphoreDelete(lock);lock=NULL;return ESP_ERR_INVALID_STATE;}
 REG(AILY_PACKET_CTRL_REG)=AILY_PACKET_ENABLE;initialized=true;transport_fenced=false;transaction=0;
 TaskHandle_t created_task=NULL;
 if(xTaskCreate(pump,AILY_WIFI_TASK_NAME,4096,NULL,3,&created_task)!=pdPASS){initialized=false;REG(AILY_PACKET_CTRL_REG)=AILY_PACKET_CLOSE;vSemaphoreDelete(lock);lock=NULL;return ESP_ERR_NO_MEM;}
 task=created_task;return ESP_OK;
}
esp_err_t __wrap_esp_wifi_deinit(void){
 if(!initialized&&!task&&!lock)return ESP_ERR_WIFI_NOT_INIT;if(!take())return ESP_ERR_TIMEOUT;
 if(started){xSemaphoreGive(lock);return ESP_ERR_INVALID_STATE;}
 initialized=associated=pending_valid=false;transport_fenced=true;if(present())REG(AILY_PACKET_CTRL_REG)=AILY_PACKET_CLOSE;
 xSemaphoreGive(lock);
 /* Cooperatively exit only after the current frame/event callback is finished.
  * Timeout retains the physical task/semaphore for a real retry. */
 TickType_t began=xTaskGetTickCount();
 while(task&&(TickType_t)(xTaskGetTickCount()-began)<pdMS_TO_TICKS(500))vTaskDelay(1);
 if(task)return ESP_ERR_TIMEOUT;
 vSemaphoreDelete(lock);lock=NULL;mode=WIFI_MODE_NULL;return ESP_OK;
}
esp_netif_t *__wrap_esp_netif_create_default_wifi_sta(void){
 if(!initialized)return NULL;if(sta)return sta;
 esp_netif_config_t cfg=ESP_NETIF_DEFAULT_WIFI_STA();
 esp_netif_driver_ifconfig_t driver={.handle=&driver_context,.transmit=transmit,.transmit_wrap=transmit_wrap,.driver_free_rx_buffer=free_rx};cfg.driver=&driver;
 sta=esp_netif_new(&cfg);if(!sta)return NULL;
 if(esp_netif_set_mac(sta,sta_mac)!=ESP_OK){esp_netif_destroy(sta);sta=NULL;return NULL;}
 const int32_t ids[4]={WIFI_EVENT_STA_START,WIFI_EVENT_STA_STOP,WIFI_EVENT_STA_CONNECTED,WIFI_EVENT_STA_DISCONNECTED};
 esp_event_handler_t actions[4]={esp_netif_action_start,esp_netif_action_stop,esp_netif_action_connected,esp_netif_action_disconnected};
 for(unsigned i=0;i<4;i++){
  if(esp_event_handler_instance_register(WIFI_EVENT,ids[i],actions[i],sta,&handlers[i])!=ESP_OK){
   while(handler_count){unsigned j=--handler_count;esp_event_handler_instance_unregister(WIFI_EVENT,ids[j],handlers[j]);}
   esp_netif_destroy(sta);sta=NULL;return NULL;
  }handler_count++;
 }
 return sta;
}
esp_netif_t *__wrap_esp_netif_create_default_wifi_ap(void){return NULL;}
void __wrap_esp_netif_destroy_default_wifi(void *netif){
 if(netif!=sta)return;
 const int32_t ids[4]={WIFI_EVENT_STA_START,WIFI_EVENT_STA_STOP,WIFI_EVENT_STA_CONNECTED,WIFI_EVENT_STA_DISCONNECTED};
 while(handler_count){unsigned i=--handler_count;esp_event_handler_instance_unregister(WIFI_EVENT,ids[i],handlers[i]);}
 sta=NULL;if(netif)esp_netif_destroy(netif);
}
esp_err_t __wrap_esp_wifi_set_mode(wifi_mode_t value){if(!active())return ESP_ERR_INVALID_STATE;if(value!=WIFI_MODE_STA&&value!=WIFI_MODE_NULL)return ESP_ERR_NOT_SUPPORTED;mode=value;return ESP_OK;}
esp_err_t __wrap_esp_wifi_get_mode(wifi_mode_t *value){if(!value)return ESP_ERR_INVALID_ARG;if(!initialized)return ESP_ERR_WIFI_NOT_INIT;*value=mode;return ESP_OK;}
esp_err_t __wrap_esp_wifi_set_storage(wifi_storage_t value){return value==WIFI_STORAGE_RAM&&active()?ESP_OK:ESP_ERR_NOT_SUPPORTED;}
esp_err_t __wrap_esp_wifi_set_config(wifi_interface_t interface,wifi_config_t *value){
 if(interface!=WIFI_IF_STA||!value)return ESP_ERR_INVALID_ARG;if(!take())return ESP_ERR_TIMEOUT;
 esp_err_t result=ESP_OK;
 if(!active())result=ESP_ERR_INVALID_STATE;
 else if(pending_valid||associated)result=ESP_ERR_WIFI_CONN;
 else if(!value->sta.ssid[0])result=ESP_ERR_INVALID_ARG;
 else if(value->sta.password[0]||value->sta.threshold.authmode!=WIFI_AUTH_OPEN||value->sta.bssid_set||value->sta.channel>1)result=ESP_ERR_NOT_SUPPORTED;
 else configuration=*value;
 xSemaphoreGive(lock);return result;
}
esp_err_t __wrap_esp_wifi_get_config(wifi_interface_t interface,wifi_config_t *value){if(interface!=WIFI_IF_STA||!value)return ESP_ERR_INVALID_ARG;if(!initialized)return ESP_ERR_WIFI_NOT_INIT;*value=configuration;return ESP_OK;}
esp_err_t __wrap_esp_wifi_start(void){if(!active()||mode!=WIFI_MODE_STA||!sta)return ESP_ERR_INVALID_STATE;if(started)return ESP_ERR_INVALID_STATE;started=true;return esp_event_post(WIFI_EVENT,WIFI_EVENT_STA_START,NULL,0,pdMS_TO_TICKS(100));}
esp_err_t __wrap_esp_wifi_stop(void){
 if(!started)return ESP_ERR_WIFI_NOT_STARTED;if(!take())return ESP_ERR_TIMEOUT;
 started=associated=pending_valid=false;transport_fenced=true;
 /* Do not reset/re-enable an untagged external peer in place. A later normal
  * Session rebind owns fresh peer/queues; guest WiFi power-cycle is unsupported. */
 if(present())REG(AILY_PACKET_CTRL_REG)=AILY_PACKET_CLOSE;
 xSemaphoreGive(lock);return esp_event_post(WIFI_EVENT,WIFI_EVENT_STA_STOP,NULL,0,pdMS_TO_TICKS(100));
}
static esp_err_t control_request(uint8_t type){
 if(!take())return ESP_ERR_TIMEOUT;
 esp_err_t result=ESP_OK;
 if(!started||!active())result=ESP_ERR_WIFI_NOT_STARTED;
 else if(pending_valid||(type==AWF_JOIN_REQ&&associated))result=ESP_ERR_WIFI_CONN;
 else if(transaction==UINT32_MAX)result=ESP_ERR_INVALID_STATE;
 else{
  struct awf_pending next={.transaction=transaction+1,.epoch=epoch,.type=type};memcpy(next.guest_mac,sta_mac,6);
  if(type==AWF_JOIN_REQ){next.ssid_length=strnlen((char*)configuration.sta.ssid,32);memcpy(next.ssid,configuration.sta.ssid,next.ssid_length);}
  else memcpy(next.bssid,ap.bssid,6);
  uint8_t frame[AWF_FRAME_BYTES];
  if(!awf_make_request(frame,&next))result=ESP_ERR_INVALID_ARG;
  else if(REG(AILY_PACKET_TX_CAP_REG)<sizeof frame)result=ESP_ERR_NO_MEM;
  else{
   /* Reserve before the first side effect; unknown commit never rolls back. */
   transaction=next.transaction;pending=next;pending_valid=true;pending_started=xTaskGetTickCount();result=send_frame(frame,sizeof frame);
   if(result!=ESP_OK){associated=false;REG(AILY_PACKET_CTRL_REG)=AILY_PACKET_CLOSE;}
  }
 }
 xSemaphoreGive(lock);return result;
}
esp_err_t __wrap_esp_wifi_connect(void){if(associated)return ESP_ERR_WIFI_CONN;return control_request(AWF_JOIN_REQ);}
esp_err_t __wrap_esp_wifi_disconnect(void){return control_request(AWF_LEAVE_REQ);}
esp_err_t __wrap_esp_wifi_set_ps(wifi_ps_type_t value){if(!active())return ESP_ERR_INVALID_STATE;power_save=value;return ESP_OK;}
esp_err_t __wrap_esp_wifi_get_mac(wifi_interface_t interface,uint8_t *mac){if(interface!=WIFI_IF_STA||!mac)return ESP_ERR_INVALID_ARG;memcpy(mac,sta_mac,6);return ESP_OK;}
void __wrap_phy_bbpll_en_usb(bool enabled){(void)enabled;}
esp_err_t __wrap_esp_wifi_get_protocol(wifi_interface_t interface,uint8_t *protocol){if(interface!=WIFI_IF_STA||!protocol)return ESP_ERR_INVALID_ARG;*protocol=WIFI_PROTOCOL_11B|WIFI_PROTOCOL_11G|WIFI_PROTOCOL_11N;return ESP_OK;}
esp_err_t __wrap_esp_wifi_set_protocol(wifi_interface_t interface,uint8_t protocol){return interface==WIFI_IF_STA&&protocol==(WIFI_PROTOCOL_11B|WIFI_PROTOCOL_11G|WIFI_PROTOCOL_11N)?ESP_OK:ESP_ERR_NOT_SUPPORTED;}
esp_err_t __wrap_esp_wifi_get_channel(uint8_t *primary,wifi_second_chan_t *secondary){if(!primary||!secondary)return ESP_ERR_INVALID_ARG;if(!associated)return ESP_ERR_WIFI_NOT_CONNECT;*primary=ap.channel;*secondary=WIFI_SECOND_CHAN_NONE;return ESP_OK;}
esp_err_t __wrap_esp_wifi_sta_get_ap_info(wifi_ap_record_t *record){if(!record)return ESP_ERR_INVALID_ARG;if(!associated)return ESP_ERR_WIFI_NOT_CONNECT;memset(record,0,sizeof *record);memcpy(record->bssid,ap.bssid,6);memcpy(record->ssid,configuration.sta.ssid,32);record->primary=ap.channel;record->authmode=WIFI_AUTH_OPEN;return ESP_OK;}

esp_err_t __wrap_esp_wifi_scan_start(const wifi_scan_config_t *config,bool block) { (void)config;(void)block;return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_wifi_scan_get_ap_num(uint16_t *number) { (void)number;return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_wifi_scan_get_ap_records(uint16_t *number,wifi_ap_record_t *records) { (void)number;(void)records;return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_wifi_get_country(wifi_country_t *country) { (void)country;return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_wifi_get_max_tx_power(int8_t *power) { (void)power;return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_wifi_set_max_tx_power(int8_t power) { (void)power;return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_wifi_restore(void) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_wifi_set_channel(uint8_t primary,wifi_second_chan_t secondary) { (void)primary;(void)secondary;return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_wifi_set_bandwidth(wifi_interface_t interface,wifi_bandwidth_t bandwidth) { (void)interface;(void)bandwidth;return ESP_ERR_NOT_SUPPORTED; }
