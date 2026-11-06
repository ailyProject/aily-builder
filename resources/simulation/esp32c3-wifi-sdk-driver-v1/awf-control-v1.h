/* AWF1 functional virtual-AP control. Not 802.11, WPA or an IP/DHCP reply. */
#ifndef AILY_AWF_CONTROL_V1_H
#define AILY_AWF_CONTROL_V1_H
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#define AWF_FRAME_BYTES 70u
#define AWF_PAYLOAD_BYTES 56u
#define AWF_JOIN_REQ 1u
#define AWF_JOIN_REPLY 2u
#define AWF_LEAVE_REQ 3u
#define AWF_LEAVE_REPLY 4u
struct awf_pending { uint32_t transaction, epoch; uint8_t type, ssid_length, ssid[32], guest_mac[6], bssid[6]; };
struct awf_reply { uint8_t result, channel, bssid[6]; };
static inline void awf_u32_write(uint8_t *b,uint32_t v){b[0]=v>>24;b[1]=v>>16;b[2]=v>>8;b[3]=v;}
static inline uint32_t awf_u32_read(const uint8_t *b){return (uint32_t)b[0]<<24|(uint32_t)b[1]<<16|(uint32_t)b[2]<<8|b[3];}
static inline int awf_make_request(uint8_t frame[AWF_FRAME_BYTES],const struct awf_pending *p){
 if(!p||!p->transaction||!p->epoch||p->ssid_length>32||(p->type!=AWF_JOIN_REQ&&p->type!=AWF_LEAVE_REQ)||(p->type==AWF_JOIN_REQ&&!p->ssid_length)||(p->type==AWF_LEAVE_REQ&&p->ssid_length))return 0;
 if(p->type==AWF_LEAVE_REQ&&((p->bssid[0]&1)||!memcmp(p->bssid,"\0\0\0\0\0\0",6)))return 0;
 memset(frame,0,AWF_FRAME_BYTES);if(p->type==AWF_JOIN_REQ)memset(frame,255,6);else memcpy(frame,p->bssid,6);memcpy(frame+6,p->guest_mac,6);frame[12]=0x88;frame[13]=0xb5;
 uint8_t *v=frame+14;memcpy(v,"AWF1",4);v[4]=1;v[5]=p->type;awf_u32_write(v+8,p->transaction);awf_u32_write(v+12,p->epoch);v[16]=p->ssid_length;if(p->type==AWF_LEAVE_REQ)memcpy(v+18,p->bssid,6);memcpy(v+24,p->ssid,p->ssid_length);return 1;
}
static inline int awf_parse_reply(const uint8_t *frame,size_t length,const struct awf_pending *p,struct awf_reply *out){
 if(!frame||!p||!out||length!=AWF_FRAME_BYTES||!p->transaction||!p->epoch||p->ssid_length>32||memcmp(frame,p->guest_mac,6)||frame[12]!=0x88||frame[13]!=0xb5)return 0;
 const uint8_t *v=frame+14;uint8_t expected=p->type==AWF_JOIN_REQ?AWF_JOIN_REPLY:p->type==AWF_LEAVE_REQ?AWF_LEAVE_REPLY:0;
 if(!expected||memcmp(v,"AWF1",4)||v[4]!=1||v[5]!=expected||v[6]!=0||v[7]>4||awf_u32_read(v+8)!=p->transaction||awf_u32_read(v+12)!=p->epoch||v[16]!=p->ssid_length||v[17]!=1||memcmp(v+24,p->ssid,p->ssid_length))return 0;
 if(p->type==AWF_LEAVE_REQ&&memcmp(v+18,p->bssid,6))return 0;
 if(v[18]&1||!memcmp(v+18,"\0\0\0\0\0\0",6)||memcmp(frame+6,v+18,6))return 0;
 for(size_t i=p->ssid_length;i<32;i++)if(v[24+i])return 0;
 out->result=v[7];out->channel=v[17];memcpy(out->bssid,v+18,6);return 1;
}
#endif
