import { db } from "@/utils/db";
import { MockInterview, UserAnswer } from "@/utils/schema";
import { v4 as uuidv4 } from "uuid";
import moment from "moment";
import { auth, currentUser } from "@clerk/nextjs/server";
import { desc, eq, avg } from "drizzle-orm";
import { ChatGroq } from "@langchain/groq";
import {
  START,
  END,
  MessagesAnnotation,
  StateGraph,
  MemorySaver,
} from "@langchain/langgraph";

const llm = new ChatGroq({
  model: "mixtral-8x7b-32768",
  apiKey: process.env.NEXT_PUBLIC_GROQ_API_KEY,
  temperature: 0,
});

// Helper function to sanitize and parse JSON response
const sanitizeAndParseJSON = (response: string): any[] => {
  try {
    // Remove any potential code block markers
    let cleaned = response.replace(/```json\n?|\n?```/g, "");
    
    // Remove any control characters
    cleaned = cleaned.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
    
    // Ensure the response starts with [ and ends with ]
    cleaned = cleaned.trim();
    if (!cleaned.startsWith("[")) cleaned = "[" + cleaned;
    if (!cleaned.endsWith("]")) cleaned = cleaned + "]";
    
    // Parse the cleaned JSON
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    console.error("JSON parsing error:", error);
    console.log("Attempted to parse:", response);
    throw new Error("Failed to parse LLM response");
  }
};

const callModel = async (state: typeof MessagesAnnotation.State) => {
  const response = await llm.invoke(state.messages);
  return { messages: response };
};

const workflow = new StateGraph(MessagesAnnotation)
  .addNode("model", callModel)
  .addEdge(START, "model")
  .addEdge("model", END);

const memory = new MemorySaver();
const app = workflow.compile({ checkpointer: memory });

const promptTemplate = `
System: For the following context: {systemContent}
Generate interview questions and answers in the following JSON format ONLY:
[
  {
    "question": "your question here",
    "answer": "your answer here"
  }
]
Ensure the response is valid JSON with no special characters or line breaks in strings.

User: {userContent}
`;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const interviewType = formData.get("interviewType") as string;
    const role = formData.get("role") as string;
    const experience = formData.get("experience") as string;
    const resumeFile = formData.get("resume") as File;

    const { userId } = await auth();
    const user = await currentUser();

    if (!userId || !user?.emailAddresses?.[0]?.emailAddress) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let llmResponse;

    if (interviewType === "resume" && resumeFile) {
      const arrayBuffer = await resumeFile.arrayBuffer();
      const base64Pdf = Buffer.from(arrayBuffer).toString("base64");

      const resumePrompt = [
        {
          role: "system",
          content: "Analyze the following resume and generate 2 relevant interview questions with answers in valid JSON format: [{'question': '...', 'answer': '...'}]",
        },
        { role: "user", content: base64Pdf },
      ];

      const result = await app.invoke(
        { messages: resumePrompt },
        { configurable: { thread_id: uuidv4() } }
      );
      llmResponse = result.messages[result.messages.length - 1].content;
    } else {
      const systemContent = interviewType === "technical" 
        ? `Role: ${role}, Experience Level: ${experience}. Generate 1 technical interview question.`
        : `Experience Level: ${experience}. Generate 1 HR interview question.`;

      const inputPrompt = promptTemplate
        .replace("{systemContent}", systemContent)
        .replace("{userContent}", "Generate the interview question now.");

      const result = await app.invoke(
        { messages: [{ role: "user", content: inputPrompt }] },
        { configurable: { thread_id: uuidv4() } }
      );
      llmResponse = result.messages[result.messages.length - 1].content;
    }

    // Parse and validate the LLM response
    const jsonResponse = sanitizeAndParseJSON(llmResponse as string);

    // Generate mock interview ID and prepare data
    const newMockId = uuidv4();
    const insertData = {
      mockId: newMockId,
      jsonMockResp: JSON.stringify(jsonResponse),
      jobPosition: role || (interviewType === "resume" ? "Resume Interview" : "HR Interview"),
      jobType: interviewType,
      jobExperience: experience,
      createdBy: user.emailAddresses[0].emailAddress,
      createdAt: moment().format("DD-MM-YYYY"),
    };

    const resp = await db
      .insert(MockInterview)
      .values(insertData)
      .returning({ mockId: MockInterview.mockId });

    return Response.json({ mockId: resp[0].mockId });
  } catch (error) {
    console.error("Error creating interview:", error);
    return Response.json(
      { error: "Failed to create interview. Please try again." },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const { userId } = await auth();
    const user = await currentUser();

    if (!userId || !user?.emailAddresses?.[0]?.emailAddress) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userEmail = user.emailAddresses[0].emailAddress;

    // Get the interviews
    const interviews = await db
      .select()
      .from(MockInterview)
      .where(eq(MockInterview.createdBy, userEmail))
      .orderBy(desc(MockInterview.createdAt));

    // Calculate average rating
    const averageRating = await db
      .select({
        averageScore: avg(UserAnswer.rating),
      })
      .from(UserAnswer)
      .where(eq(UserAnswer.userEmail, userEmail));

    let formattedAverageScore = "0.0";
    const avgScore = averageRating[0]?.averageScore;
    if (avgScore !== null && avgScore !== undefined) {
      formattedAverageScore = Number(avgScore).toFixed(1);
    }

    return Response.json({
      interviews,
      stats: {
        completedInterviews: interviews.length,
        averageScore: formattedAverageScore,
        totalHours: "12.5",
        upcomingSessions: "3",
      },
    });
  } catch (error) {
    console.error("Error fetching interviews:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}