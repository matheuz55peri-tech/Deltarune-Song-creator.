# ✦ Darkwave Studio — Deltarune Song Creator

Um **estúdio musical online gratuito para criar trilhas originais de RPG**, com estética de RPG retrô inspirada na atmosfera de *DELTARUNE*. Funciona inteiramente no navegador; não exige conta, servidor ou instalação.

> Projeto independente de fãs. Não é afiliado a Toby Fox, DELTARUNE ou seus distribuidores. As músicas de exemplo foram compostas para este projeto, sem uso de gravações, sprites ou faixas oficiais.

## ✨ O que está pronto

### Atualização: estúdio, voz e arranjador automático

- **Prévia de instrumento:** clique em **▶** em cada faixa ou em **▶ OUVIR SOM** no editor para ouvir o timbre antes de adicionar notas. Também existe **PRÉVIA AO PASSAR**, que toca a nota sob o mouse sem escrevê-la.
- **Gravador de voz:** nova aba **Cantarolar** para gravar pelo microfone (até 45 segundos), reproduzir o áudio e convertê-lo em notas ou batidas. Você escolhe modo automático, melodia, baixo ou ritmo, quantização e detecção automática de BPM ou BPM do estúdio.
- **Transcrição de voz:** analisa periodicidade para identificar tom, suaviza saltos de oitava e arredonda notas/tempos à grade. Escolhe sintetizador retrô aproximado usando registro, brilho e articulação. Não copia exatamente a voz nem garante notas perfeitas.
- **Importação musical para faixas:** na aba **Conversor**, o botão **DESMONTAR E COLOCAR NO ESTÚDIO** usa estimativas espectrais para distribuir melodia, graves, harmonia e transientes nas faixas do estúdio. É uma **separação aproximada**, não uma extração de instrumentos originais: músicas complexas podem exigir edição.
- **Projetos maiores:** agora você pode selecionar 4, 8, 16 ou 32 compassos; o arranjador amplia automaticamente a grade conforme necessário, até esse limite.
- **Operação local e privada:** o áudio do microfone ou do arquivo é processado no próprio navegador. O microfone exige HTTPS (já fornecido pelo GitHub Pages) e autorização de acesso.
- **Performance:** a transcrição analisa gravações de até 65 segundos (gravação pelo site: 45 s); o importador analisa os primeiros 75 segundos de música, respeitando o limite de 32 compassos. Resultados melhores com áudio limpo, mix pouco densa e notas bem definidas.



- **Piano roll** de 64 a 512 passos (4–32 compassos em 4/4) com 28 alturas de notas, duração de notas ajustável, desenho por arraste e exclusão por clique ou botão direito.
- **8 pistas**: Lead dos Sonhos, Teclas Encantadas, Sinos de Cristal, Baixo Profundo, Névoa Estelar, Arpejo Mágico, Kick e Hat, todas sintetizadas no navegador via Web Audio API.
- Controle de **BPM (50–240)**, swing, volume, mute, solo, play/pause, stop e desfazer.
- **Três composições demonstrativas originais** (Batalha, Sonho e Mistério) e projeto vazio.
- **Exportação de WAV** estéreo usando OfflineAudioContext, pronta para editar ou usar em RPG.
- **Salvar múltiplos projetos no navegador** (localStorage), abrir, excluir, exportar e importar **JSON** para compartilhar com amigos.
- **Conversor experimental de áudio**: importa WAV/MP3/OGG compatível e cria versão com bit depth e taxa de amostragem efetiva reduzidos; permite ouvir e baixar WAV.
- **Extrator básico de melodia (beta)**: tenta detectar uma linha monofônica e inseri-la no editor. Melhor com áudio de um instrumento solo. Não faz separação de stems nem converte automaticamente uma música inteira em uma composição nova de DELTARUNE.
- Layout responsivo, teclado acessível e ajuda integrada.

## 🌐 Publicar com GitHub Pages

1. Abra a página **Settings → Pages** deste repositório.
2. Em **Build and deployment**, selecione **Deploy from a branch**.
3. Escolha **main** e **/(root)**; clique em **Save**.
4. Quando o GitHub Pages publicar, o endereço aparecerá nessa mesma tela.

Não é necessário Node, build ou workflow: o site é feito com arquivos estáticos na raiz.

## 🎼 Como usar

1. Abra o **Estúdio** e selecione uma faixa.
2. Clique nas células da grade para desenhar notas. Segure o botão e arraste para escrever várias.
3. Selecione a duração da nota, altere BPM e pressione **Play**.
4. Use **Exportar WAV** para gerar o áudio.
5. Use **Salvar no estúdio** para manter vários projetos neste navegador e **Baixar projeto** para ter uma cópia permanente.

**Atalhos:** Espaço = play/pause; Ctrl+S = salvar uma versão na biblioteca; Ctrl+Z = desfazer; teclas 1–8 = selecionar faixas.

## 🔧 Arquivos

- \`index.html\` — estrutura da interface
- \`style.css\` — visual responsivo
- \`app.js\` — sequenciador, síntese, projetos e conversor
- \`audio-lab.js\` — gravação local, detecção de notas/batidas e importador espectral aproximado

### Imagem de fundo personalizada

A arte de fundo definitiva poderá ser incorporada quando for fornecida. A atual usa gradientes, estrelas e elementos abstratos feitos com CSS — sem imagens de terceiros.

## Privacidade e limitações

Todas as músicas e os arquivos importados são processados no **próprio navegador**; o site não envia áudio a servidores. Os salvamentos locais podem desaparecer caso o navegador limpe os dados do site: **exporte o JSON** para fazer backup. WAVs exportados pelo sequenciador duram os compassos definidos no projeto (4, 8, 16 ou 32). O processamento retrô de áudio limita o resultado aos primeiros 180 segundos do arquivo. O site funciona melhor nas versões recentes do Chrome, Edge e Firefox.

Nenhum áudio ou arte oficial de DELTARUNE é distribuído neste repositório.


## 🖼️ GIF animado do projeto

O arquivo \`assets/deltarune-background.gif\` foi enviado pelo proprietário do projeto e está hospedado **no próprio repositório**, sem depender de links externos. A animação aparece ao fundo da página e também como destaque à direita do cabeçalho.

O CSS mantém a arte em proporção, aplica camadas escuras para legibilidade e ajusta o enquadramento para celular. O navegador respeita \`prefers-reduced-motion\`, evitando a animação quando o usuário pede movimento reduzido. A paleta da interface acompanha os tons de azul elétrico, ciano e preto da imagem.
