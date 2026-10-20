import { notFound } from '../../../utils/AppError.js';
import { getUserWithProfile } from '../../users/user.repository.js';
import { createManagedAccount } from '../accounts/accounts.service.js';
import { assignWithin } from '../teaching/teaching.service.js';
import * as repo from './professors.repository.js';

export const listProfessors = (query) => repo.listProfessors(query);

export async function getProfessor(professorId) {
  const user = await getUserWithProfile(professorId);
  if (!user || user.role !== 'professor') throw notFound('Professor');
  const [workload, courses, modules, batches, reviews] = await Promise.all([
    repo.professorWorkload(professorId),
    repo.professorCourses(professorId),
    repo.professorModules(professorId),
    repo.professorBatches(professorId),
    repo.recentReviews(professorId),
  ]);
  return { ...user, workload, courses, modules, batches, recentReviews: reviews };
}

export async function createProfessor(data, actor) {
  const professor = await createManagedAccount('professor', data, actor, async (user, db) => {
    for (const courseId of data.courseIds) await assignWithin(db, 'course', courseId, user.id, actor);
  });
  return { ...(await getProfessor(professor.id)), welcomeEmail: professor.welcomeEmail };
}
