
## gepa (74 observations, runner dspy-rlm)
micro recall 0.3017 precision 0.1282 F1 0.1799 (matched 35/116, supported 35/273)
gold-step classes: {"hit":31,"near":10,"far":6,"silent":5,"blindHit":4,"blind":60}
finding classes:   {"supported":35,"near":53,"pad":185,"padSolved":118,"padUnsolved":67}
counterfactual micro F1:
  dropBlindGold    recall 0.5962 precision 0.1152 F1 0.1931 (delta 0.0132)
  snapNear         recall 0.5603 precision 0.2381 F1 0.3342 (delta 0.1542)
  dropEscaped      recall 0.2241 precision 0.1327 F1 0.1667 (delta -0.0133)
  abstainSolved    recall 0.0603 precision 0.0814 F1 0.0693 (delta -0.1106)

| case | solved | annotation | steps | gold | input-blind gold | rep | findings | cited | matched | classes |
| --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | --- | --- |
| miniswe-Anthropic__Claude-Sonnet-4-20250514-Thinking-sam-cell-seg-93dae667 | no | agent_failure_analysis | 20 | 8,13 | - | 0 | 2 | 13,20 | 13 | 8:far 13:hit |
| miniswe-Anthropic__Claude-Sonnet-4-20250514-Thinking-sam-cell-seg-93dae667 | no | agent_failure_analysis | 20 | 8,13 | - | 1 | 2 | 13,20 | 13 | 8:far 13:hit |
| miniswe-Anthropic__Claude-Sonnet-4-20250514-Thinking-vul-flask-4946dda9 | no | agent_failure_analysis | 36 | 30,32,34 | - | 1 | 11 | 10,11,12,21,22,23,24,25,26,27,28 | - | 30:near 32:far 34:far |
| miniswe-Anthropic__Claude-Sonnet-4-20250514-Thinking-vul-flask-4946dda9 | no | agent_failure_analysis | 36 | 30,32,34 | - | 0 | 0 | - | - | 30:silent 32:silent 34:silent |
| miniswe-DeepSeek__DeepSeek-V3.2-build-linux-kernel-qemu-ea803cf1 | no | agent_failure_analysis | 31 | 31 | 31 | 0 | 3 | 11,23,31 | 31 | 31:blindHit |
| miniswe-DeepSeek__DeepSeek-V3.2-build-linux-kernel-qemu-ea803cf1 | no | agent_failure_analysis | 31 | 31 | 31 | 1 | 3 | 12,21,31 | 31 | 31:blindHit |
| miniswe-DeepSeek__DeepSeek-V3.2-merge-diff-arc-agi-task-cb5aafdd | no | agent_failure_analysis | 21 | 6 | - | 1 | 6 | 10,12,14,16,18,20 | - | 6:far |
| miniswe-DeepSeek__DeepSeek-V3.2-merge-diff-arc-agi-task-cb5aafdd | no | agent_failure_analysis | 21 | 6 | - | 0 | 3 | 18,19,20 | - | 6:far |
| miniswe-DeepSeek__DeepSeek-V3.2-protein-assembly-472264a0 | no | agent_failure_analysis | 24 | 24 | 24 | 0 | 6 | 17,18,19,20,21,22 | - | 24:blind |
| miniswe-DeepSeek__DeepSeek-V3.2-protein-assembly-472264a0 | no | agent_failure_analysis | 24 | 24 | 24 | 1 | 5 | 13,17,18,21,22 | - | 24:blind |
| miniswe-OpenAI__GPT-5-django__django-14999-5d6ca542 | yes | merged_cleaned_step20_three_waves | 20 | 7,8,19 | 19 | 0 | 0 | - | - | 7:silent 8:silent 19:blind |
| miniswe-OpenAI__GPT-5-django__django-14999-5d6ca542 | yes | merged_cleaned_step20_three_waves | 20 | 7,8,19 | 19 | 1 | 1 | 7 | 7 | 7:hit 8:near 19:blind |
| miniswe-OpenAI__GPT-5-facebook__zstd-2094-7f31a0cb | yes | merged_cleaned_step25 | 28 | 27 | 27 | 0 | 5 | 17,22,23,24,25 | - | 27:blind |
| miniswe-OpenAI__GPT-5-facebook__zstd-2094-7f31a0cb | yes | merged_cleaned_step25 | 28 | 27 | 27 | 1 | 10 | 17,18,19,20,21,22,23,24,25,28 | - | 27:blind |
| miniswe-OpenAI__GPT-5-fasterxml__jackson-databind-4641-989d1554 | yes | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 1 | 3 | 19,20,21 | - | 22:blind |
| miniswe-OpenAI__GPT-5-fasterxml__jackson-databind-4641-989d1554 | yes | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 0 | 3 | 19,20,21 | - | 22:blind |
| miniswe-OpenAI__GPT-5-fasterxml__jackson-dataformat-xml-638-5311424b | yes | merged_cleaned_step20_three_waves | 24 | 18 | - | 1 | 3 | 18,19,20 | 18 | 18:hit |
| miniswe-OpenAI__GPT-5-fasterxml__jackson-dataformat-xml-638-5311424b | yes | merged_cleaned_step20_three_waves | 24 | 18 | - | 0 | 5 | 18,19,20,21,22 | 18 | 18:hit |
| miniswe-OpenAI__GPT-5-fmtlib__fmt-4286-f5dcb102 | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 0 | 2 | 12,17 | - | 19:blind |
| miniswe-OpenAI__GPT-5-fmtlib__fmt-4286-f5dcb102 | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 1 | 2 | 12,17 | - | 19:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-0fd88717c953b92ed8a50495d55e630eb5d59166-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-09135d56 | yes | merged_cleaned_step20_three_waves | 21 | 20 | 20 | 0 | 2 | 12,13 | - | 20:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-0fd88717c953b92ed8a50495d55e630eb5d59166-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-09135d56 | yes | merged_cleaned_step20_three_waves | 21 | 20 | 20 | 1 | 6 | 2,5,12,13,14,15 | - | 20:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-1a4644ff15355fd696ac5b9d074a566a80fe7ca3-v30a923fb5c164d6cd18280c02422f75e611e8fb2-e1edb594 | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 0 | 8 | 10,11,12,13,14,15,16,17 | - | 19:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-1a4644ff15355fd696ac5b9d074a566a80fe7ca3-v30a923fb5c164d6cd18280c02422f75e611e8fb2-e1edb594 | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 1 | 1 | 10 | - | 19:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-1b70260d5aa2f6c9782fd2b848e8d16566e50d85-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-0b674c2a | no | merged_cleaned_step25 | 38 | 37 | 37 | 0 | 1 | 36 | - | 37:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-1b70260d5aa2f6c9782fd2b848e8d16566e50d85-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-0b674c2a | no | merged_cleaned_step25 | 38 | 37 | 37 | 1 | 2 | 18,27 | - | 37:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-5640093f1ca63fd6af231cc8a7fb7d40e1907b8c-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-21500546 | yes | merged_cleaned_step20_three_waves | 24 | 21,23 | 23 | 1 | 3 | 21,22,24 | 21 | 21:hit 23:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-5640093f1ca63fd6af231cc8a7fb7d40e1907b8c-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-21500546 | yes | merged_cleaned_step20_three_waves | 24 | 21,23 | 23 | 0 | 2 | 6,21 | 21 | 21:hit 23:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-9142be2f6cabbe6597c9254c5bb9186d17036d55-v0f01c69f1e2528b935359cfe578530722bca2c59-48b421ba | no | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 1 | 3 | 12,13,20 | - | 19:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-9142be2f6cabbe6597c9254c5bb9186d17036d55-v0f01c69f1e2528b935359cfe578530722bca2c59-48b421ba | no | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 0 | 2 | 13,18 | - | 19:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-949c503f2ef4b2c5d668af0492a5c0db1ab86140-v0f01c69f1e2528b935359cfe578530722bca2c59-3a45c2a2 | no | merged_cleaned_step25 | 27 | 26 | 26 | 1 | 1 | 22 | - | 26:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-949c503f2ef4b2c5d668af0492a5c0db1ab86140-v0f01c69f1e2528b935359cfe578530722bca2c59-3a45c2a2 | no | merged_cleaned_step25 | 27 | 26 | 26 | 0 | 1 | 22 | - | 26:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-bec27fb4c0a40c5f8bbcf26a475704227d65ee73-v30a923fb5c164d6cd18280c02422f75e611e8fb2-1af9d682 | no | merged_cleaned_step25 | 36 | 35 | 35 | 0 | 11 | 24,25,26,27,28,29,30,31,32,33,34 | - | 35:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-bec27fb4c0a40c5f8bbcf26a475704227d65ee73-v30a923fb5c164d6cd18280c02422f75e611e8fb2-1af9d682 | no | merged_cleaned_step25 | 36 | 35 | 35 | 1 | 1 | 24 | - | 35:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-cb94c0cc550df9e98f1247bc71d8c2b861c75049-v1055803c3a812189a1133297f7f5468579283f86-6c8d52c0 | no | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 0 | 2 | 14,16 | - | 22:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-cb94c0cc550df9e98f1247bc71d8c2b861c75049-v1055803c3a812189a1133297f7f5468579283f86-6c8d52c0 | no | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 1 | 1 | 14 | - | 22:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-f8ef34672b961a95ec7282643679492862c688ec-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-f91ad040 | yes | merged_cleaned_step25 | 36 | 35 | 35 | 0 | 6 | 15,26,27,28,33,34 | - | 35:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-f8ef34672b961a95ec7282643679492862c688ec-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-f91ad040 | yes | merged_cleaned_step25 | 36 | 35 | 35 | 1 | 4 | 15,26,27,28 | - | 35:blind |
| miniswe-OpenAI__GPT-5-instance_element-hq__element-web-5dfde12c1c1c0b6e48f17e3405468593e39d9492-vnan-15dbf87c | yes | merged_cleaned_step25 | 33 | 32 | 32 | 0 | 4 | 22,23,25,31 | - | 32:blind |
| miniswe-OpenAI__GPT-5-instance_element-hq__element-web-5dfde12c1c1c0b6e48f17e3405468593e39d9492-vnan-15dbf87c | yes | merged_cleaned_step25 | 33 | 32 | 32 | 1 | 10 | 22,23,24,25,26,27,28,29,30,31 | - | 32:blind |
| miniswe-OpenAI__GPT-5-instance_element-hq__element-web-aeabf3b18896ac1eb7ae9757e66ce886120f8309-vnan-dc9947f9 | yes | merged_cleaned_step25 | 30 | 21,22,29 | 29 | 1 | 4 | 21,28,29,30 | 21,29 | 21:hit 22:near 29:blindHit |
| miniswe-OpenAI__GPT-5-instance_element-hq__element-web-aeabf3b18896ac1eb7ae9757e66ce886120f8309-vnan-dc9947f9 | yes | merged_cleaned_step25 | 30 | 21,22,29 | 29 | 0 | 3 | 21,22,28 | 21,22 | 21:hit 22:hit 29:blind |
| miniswe-OpenAI__GPT-5-instance_internetarchive__openlibrary-bb152d23c004f3d68986877143bb0f83531fe401-ve8c8d62a2b60610a3c4631f5f23ed866bada9818-78872a1e | no | merged_cleaned_step25 | 30 | 29 | 29 | 1 | 3 | 19,20,21 | - | 29:blind |
| miniswe-OpenAI__GPT-5-instance_internetarchive__openlibrary-bb152d23c004f3d68986877143bb0f83531fe401-ve8c8d62a2b60610a3c4631f5f23ed866bada9818-78872a1e | no | merged_cleaned_step25 | 30 | 29 | 29 | 0 | 3 | 19,20,21 | - | 29:blind |
| miniswe-OpenAI__GPT-5-instance_qutebrowser__qutebrowser-f8e7fea0becae25ae20606f1422068137189fe9e-b08f9fd3 | no | merged_cleaned_step20_three_waves | 22 | 21,22 | 21,22 | 1 | 1 | 14 | - | 21:blind 22:blind |
| miniswe-OpenAI__GPT-5-instance_qutebrowser__qutebrowser-f8e7fea0becae25ae20606f1422068137189fe9e-b08f9fd3 | no | merged_cleaned_step20_three_waves | 22 | 21,22 | 21,22 | 0 | 1 | 14 | - | 21:blind 22:blind |
| miniswe-OpenAI__GPT-5-keras-team__keras-19484-2bd0f0db | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 1 | 7 | 11,12,13,14,15,16,17 | - | 19:blind |
| miniswe-OpenAI__GPT-5-keras-team__keras-19484-2bd0f0db | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 0 | 2 | 14,20 | - | 19:blind |
| miniswe-OpenAI__GPT-5-keras-team__keras-19636-0123c279 | yes | merged_cleaned_step25 | 27 | 23 | - | 1 | 2 | 23,24 | 23 | 23:hit |
| miniswe-OpenAI__GPT-5-keras-team__keras-19636-0123c279 | yes | merged_cleaned_step25 | 27 | 23 | - | 0 | 5 | 23,24,25,26,27 | 23 | 23:hit |
| miniswe-OpenAI__GPT-5-matplotlib__matplotlib-24627-ee685446 | yes | merged_cleaned_step20_three_waves | 22 | 14 | - | 0 | 3 | 14,16,18 | 14 | 14:hit |
| miniswe-OpenAI__GPT-5-matplotlib__matplotlib-24627-ee685446 | yes | merged_cleaned_step20_three_waves | 22 | 14 | - | 1 | 3 | 16,17,18 | - | 14:near |
| miniswe-OpenAI__GPT-5-mockito__mockito-3220-ce8a6968 | yes | merged_cleaned_step20_three_waves | 22 | 21 | 21 | 1 | 9 | 9,10,11,12,13,14,15,16,17 | - | 21:blind |
| miniswe-OpenAI__GPT-5-mockito__mockito-3220-ce8a6968 | yes | merged_cleaned_step20_three_waves | 22 | 21 | 21 | 0 | 9 | 9,10,11,12,13,14,15,16,17 | - | 21:blind |
| miniswe-OpenAI__GPT-5-nushell__nushell-13357-4bd10bdc | yes | merged_cleaned_step25 | 31 | 28,30 | 30 | 0 | 3 | 24,27,28 | 28 | 28:hit 30:blind |
| miniswe-OpenAI__GPT-5-nushell__nushell-13357-4bd10bdc | yes | merged_cleaned_step25 | 31 | 28,30 | 30 | 1 | 1 | 27 | - | 28:near 30:blind |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-2205-2a662253 | yes | merged_cleaned_step25 | 32 | 27,28,31 | 31 | 0 | 8 | 3,4,5,6,8,27,28,32 | 27,28 | 27:hit 28:hit 31:blind |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-2205-2a662253 | yes | merged_cleaned_step25 | 32 | 27,28,31 | 31 | 1 | 3 | 27,28,32 | 27,28 | 27:hit 28:hit 31:blind |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-2247-a9fb6037 | yes | merged_cleaned_step20_three_waves | 22 | 21 | 21 | 1 | 1 | 18 | - | 21:blind |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-2247-a9fb6037 | yes | merged_cleaned_step20_three_waves | 22 | 21 | 21 | 0 | 0 | - | - | 21:blind |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-3973-6087c41b | yes | merged_cleaned_step20_three_waves | 23 | 20 | - | 1 | 1 | 20 | 20 | 20:hit |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-3973-6087c41b | yes | merged_cleaned_step20_three_waves | 23 | 20 | - | 0 | 4 | 20,21,22,23 | 20 | 20:hit |
| miniswe-OpenAI__GPT-5-simdjson__simdjson-2016-953561fe | yes | merged_cleaned_step25 | 41 | 24,26,40,41 | 40,41 | 0 | 7 | 24,26,29,31,34,37,39 | 24,26 | 24:hit 26:hit 40:blind 41:blind |
| miniswe-OpenAI__GPT-5-simdjson__simdjson-2016-953561fe | yes | merged_cleaned_step25 | 41 | 24,26,40,41 | 40,41 | 1 | 4 | 24,29,30,31 | 24 | 24:hit 26:near 40:blind 41:blind |
| miniswe-OpenAI__GPT-5-sphinx-doc__sphinx-11445-fa910280 | no | merged_cleaned_step20_three_waves | 26 | 17,19,20,25 | 25 | 0 | 6 | 4,5,11,16,19,21 | 19 | 17:near 19:hit 20:near 25:blind |
| miniswe-OpenAI__GPT-5-sphinx-doc__sphinx-11445-fa910280 | no | merged_cleaned_step20_three_waves | 26 | 17,19,20,25 | 25 | 1 | 6 | 4,5,15,17,19,21 | 17,19 | 17:hit 19:hit 20:near 25:blind |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-11913-1fe8a1b7 | yes | merged_cleaned_step20_three_waves | 22 | 19,21 | 21 | 0 | 4 | 19,20,21,22 | 19,21 | 19:hit 21:blindHit |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-11913-1fe8a1b7 | yes | merged_cleaned_step20_three_waves | 22 | 19,21 | 21 | 1 | 1 | 19 | 19 | 19:hit 21:blind |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-13097-f6faf669 | yes | merged_cleaned_step20_three_waves | 22 | 22 | 22 | 1 | 3 | 12,16,18 | - | 22:blind |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-13097-f6faf669 | yes | merged_cleaned_step20_three_waves | 22 | 22 | 22 | 0 | 7 | 12,13,14,15,16,17,18 | - | 22:blind |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-9962-571c4e95 | yes | merged_cleaned_step25 | 27 | 21,22,26 | 26 | 0 | 1 | 22 | 22 | 21:near 22:hit 26:blind |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-9962-571c4e95 | yes | merged_cleaned_step25 | 27 | 21,22,26 | 26 | 1 | 2 | 21,22 | 21,22 | 21:hit 22:hit 26:blind |
| miniswe-OpenAI__GPT-5-vuejs__core-9213-5aade8e3 | yes | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 1 | 5 | 13,17,18,19,21 | - | 22:blind |
| miniswe-OpenAI__GPT-5-vuejs__core-9213-5aade8e3 | yes | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 0 | 5 | 11,12,13,17,18 | - | 22:blind |
